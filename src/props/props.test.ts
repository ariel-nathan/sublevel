import { describe, expect, test } from "bun:test";
import type {
  Aabb,
  ContactEvent,
  DrawItem,
  LevelData,
  MeshHandle,
  PhysicsWorld,
  PropKind,
  PropSpawn,
  RayHit,
  WorldEvent,
  WorldObjects,
} from "../core/api";
import { PROP_KINDS } from "../core/api";
import type { SurfaceKind } from "../core/materials";
import type { MeshData } from "../core/mesh";
import { PLAYER, PROP_SPECS } from "../core/props";
import { buildLevel } from "../level";
import { mat4, quat, v3, type Vec3 } from "../math";
import { createPhysicsWorld } from "../physics";
import { BREAK_IMPULSE, DEBRIS_LIFETIME } from "./breakables";
import { createWorldObjects } from "./index";
import { buildPropMeshes } from "./meshes";

const FIXED_DT = 1 / 60;
const BUILT = buildLevel();
const LEVEL = BUILT.data;
const Y = v3.create(0, 1, 0);
const FAR_BOX: Aabb = {
  min: v3.create(100, 100, 100),
  max: v3.create(101, 101.8, 101),
};

interface Rig {
  physics: PhysicsWorld;
  world: WorldObjects;
  meshes: MeshData[];
  freed: number[];
  events: WorldEvent[];
  level: LevelData;
  /** Steps `seconds` of simulation; `player` may set the player's box. */
  run(seconds: number, player?: { box: Aabb; mass: number }): WorldEvent[];
  /** One step, returning the contacts drained from it. */
  stepOnce(player?: { box: Aabb; mass: number }): ContactEvent[];
}

function makeRig(props?: PropSpawn[], seed = 7): Rig {
  const level: LevelData = props ? { ...LEVEL, props } : LEVEL;
  const physics = createPhysicsWorld();
  for (const collider of BUILT.colliders) {
    physics.addStatic(collider);
  }
  const meshes: MeshData[] = [];
  const freed: number[] = [];
  const renderer = {
    createMesh(data: MeshData): MeshHandle {
      meshes.push(data);
      return { id: meshes.length - 1 };
    },
    destroyMesh(handle: MeshHandle): void {
      freed.push(handle.id);
    },
  };
  const world = createWorldObjects({ level, physics, renderer, seed });
  const events: WorldEvent[] = [];
  const stepOnce = (player?: { box: Aabb; mass: number }): ContactEvent[] => {
    physics.step(FIXED_DT);
    const contacts = physics.drainContacts();
    events.push(
      ...world.update(FIXED_DT, {
        contacts,
        playerBox: player?.box ?? FAR_BOX,
        playerMass: player?.mass ?? 80,
      }),
    );
    return contacts;
  };
  return {
    physics,
    world,
    meshes,
    freed,
    events,
    level,
    stepOnce,
    run(seconds, player) {
      const before = events.length;
      const steps = Math.round(seconds / FIXED_DT);
      for (let i = 0; i < steps; i++) {
        stepOnce(player);
      }
      return events.slice(before);
    },
  };
}

function ofType<T extends WorldEvent["type"]>(
  events: readonly WorldEvent[],
  type: T,
): Extract<WorldEvent, { type: T }>[] {
  return events.filter(
    (e): e is Extract<WorldEvent, { type: T }> => e.type === type,
  );
}

function prop(
  kind: PropKind,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): PropSpawn {
  return { kind, position: v3.create(x, y, z), yaw };
}

/** Centre height of a prop of `kind` resting on a floor at y = 0. */
function restY(kind: PropKind): number {
  return PROP_SPECS[kind].halfExtents.y;
}

function bodyTagged(physics: PhysicsWorld, tag: string): number {
  const body = physics.bodies().find((b) => b.tag === tag);
  if (!body) {
    throw new Error(`no body tagged ${tag}`);
  }
  return body.id;
}

function rayAt(
  point: Vec3,
  kind: "static" | "body" = "static",
  id = 0,
): RayHit {
  return {
    collider: { kind, id },
    point,
    normal: v3.create(0, 1, 0),
    distance: 1,
  };
}

/** Draw items every rig has besides props: doors, plate parts, button parts. */
const EXTRA_ITEMS =
  LEVEL.doors.length + LEVEL.plates.length * 2 + LEVEL.buttons.length * 2;
const PLATE = LEVEL.plates[0];
const PLATE_CENTRE = v3.scale(v3.add(PLATE.box.min, PLATE.box.max), 0.5);
const DOOR_A = LEVEL.doors[0];
const DOOR_B = LEVEL.doors[1];

/** True if something solid occupies the middle of the door's doorway. */
function doorwayBlocked(physics: PhysicsWorld, def: typeof DOOR_A): boolean {
  const c = v3.scale(v3.add(def.closed.min, def.closed.max), 0.5);
  const refs = physics.overlapBox({
    min: v3.create(c.x - 0.05, c.y - 0.3, c.z - 0.3),
    max: v3.create(c.x + 0.05, c.y + 0.3, c.z + 0.3),
  });
  return refs.some((r) => r.kind === "kinematic");
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("construction", () => {
  test("every prop becomes a body with the right tag and mass", () => {
    const rig = makeRig();
    const bodies = rig.physics.bodies();
    expect(bodies.length).toBe(LEVEL.props.length);
    LEVEL.props.forEach((spawn, i) => {
      const body = bodies[i];
      expect(body.tag).toBe(spawn.kind);
      expect(body.mass).toBe(PROP_SPECS[spawn.kind].mass);
      expect(body.halfExtents).toEqual(PROP_SPECS[spawn.kind].halfExtents);
      expect(v3.distance(body.position, spawn.position)).toBeLessThan(1e-6);
    });
  });

  test("props are at rest for the first 3 seconds", () => {
    const rig = makeRig();
    const start = rig.physics.bodies().map((b) => v3.clone(b.position));
    let maxMove = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 180; i++) {
      rig.stepOnce();
      rig.physics.bodies().forEach((body, index) => {
        maxMove = Math.max(maxMove, v3.distance(body.position, start[index]));
        maxSpeed = Math.max(maxSpeed, v3.length(body.linearVelocity));
      });
    }
    expect(maxMove).toBeLessThan(0.02);
    expect(maxSpeed).toBeLessThan(0.2);
  });

  test("resting props make no impact events", () => {
    const rig = makeRig();
    const events = rig.run(4);
    expect(ofType(events, "impact").length).toBe(0);
    expect(ofType(events, "break").length).toBe(0);
  });

  test("meshes are registered once per kind and valid", () => {
    const rig = makeRig();
    const kinds = new Set(LEVEL.props.map((p) => p.kind));
    expect(kinds.size).toBeGreaterThan(3);
    expect(rig.meshes.length).toBeGreaterThanOrEqual(kinds.size);
    for (const mesh of rig.meshes) {
      expectValidMesh(mesh);
    }
  });

  for (const kind of PROP_KINDS) {
    test(`${kind} mesh is valid, outward, and inside its bounds`, () => {
      const parts = buildPropMeshes(kind);
      const half = PROP_SPECS[kind].halfExtents;
      let triangles = 0;
      for (const mesh of parts) {
        expectValidMesh(mesh);
        triangles += mesh.indices.length / 3;
        for (let i = 0; i < mesh.positions.length; i += 3) {
          expect(Math.abs(mesh.positions[i])).toBeLessThanOrEqual(
            half.x + 1e-3,
          );
          expect(Math.abs(mesh.positions[i + 1])).toBeLessThanOrEqual(
            half.y + 1e-3,
          );
          expect(Math.abs(mesh.positions[i + 2])).toBeLessThanOrEqual(
            half.z + 1e-3,
          );
        }
      }
      expect(triangles).toBeLessThan(kind === "chair" ? 150 : 100);
    });
  }

  test("crates show exactly one repeat per face", () => {
    for (const [kind, material] of [
      ["crate_wood", "crate_wood"],
      ["crate_wood_small", "crate_wood"],
      ["crate_metal", "crate_metal"],
      ["crate_weak", "crate_wood_weak"],
    ] as const) {
      const [mesh] = buildPropMeshes(kind);
      expect(mesh.material).toBe(material);
      expect(mesh.indices.length).toBe(36);
      for (let face = 0; face < 6; face++) {
        const us = [0, 1, 2, 3].map((k) => mesh.uvs[(face * 4 + k) * 2]);
        const vs = [0, 1, 2, 3].map((k) => mesh.uvs[(face * 4 + k) * 2 + 1]);
        expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1, 5);
        expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(1, 5);
      }
    }
  });

  test("barrel: 12-sided side wrapped once, caps wind outward", () => {
    const [side, caps] = buildPropMeshes("barrel");
    expect(side.material).toBe("barrel_side");
    expect(caps.material).toBe("barrel_top");
    expect(Math.max(...side.uvs.filter((_, i) => i % 2 === 0))).toBeCloseTo(1);
    // Two fans of 12 triangles.
    expect(caps.indices.length / 3).toBe(24);
    for (let i = 0; i < caps.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) =>
        vertexAt(caps, caps.indices[i + k]),
      );
      const face = v3.normalize(v3.cross(v3.sub(b, a), v3.sub(c, a)));
      // Top fan faces up, bottom fan faces down, matching where it sits.
      expect(face.y * a.y).toBeGreaterThan(0.9 * Math.abs(a.y));
    }
  });

  test("monitor screen faces -Z and chair backrest is at +Z", () => {
    const monitor = buildPropMeshes("monitor");
    const screen = monitor.find((m) => m.material === "monitor_screen");
    expect(screen).toBeDefined();
    expect(screen?.normals[2]).toBe(-1);
    const chair = buildPropMeshes("chair");
    expect(chair.map((m) => m.material)).toEqual([
      "plastic_white",
      "metal_panel",
      "rubber_dark",
    ]);
  });
});

function vertexAt(mesh: MeshData, index: number): Vec3 {
  return v3.create(
    mesh.positions[index * 3],
    mesh.positions[index * 3 + 1],
    mesh.positions[index * 3 + 2],
  );
}

function expectValidMesh(mesh: MeshData): void {
  const count = mesh.positions.length / 3;
  expect(mesh.normals.length).toBe(count * 3);
  expect(mesh.uvs.length).toBe(count * 2);
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.length).toBeGreaterThan(0);
  for (const index of mesh.indices) {
    expect(index).toBeLessThan(count);
  }
  for (let i = 0; i < count; i++) {
    expect(
      Math.hypot(
        mesh.normals[i * 3],
        mesh.normals[i * 3 + 1],
        mesh.normals[i * 3 + 2],
      ),
    ).toBeCloseTo(1, 4);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[i + k]);
    const pa = vertexAt(mesh, a);
    const pb = vertexAt(mesh, b);
    const pc = vertexAt(mesh, c);
    const cross = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
    if (v3.length(cross) < 1e-9) {
      continue;
    }
    const face = v3.normalize(cross);
    for (const index of [a, b, c]) {
      const normal = v3.create(
        mesh.normals[index * 3],
        mesh.normals[index * 3 + 1],
        mesh.normals[index * 3 + 2],
      );
      expect(v3.dot(face, normal)).toBeGreaterThan(0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Doors and buttons
// ---------------------------------------------------------------------------

describe("buttons and door A", () => {
  const button = LEVEL.buttons[0];
  const hit = rayAt(button.position);

  test("use near a button toggles the door; events fire once each", () => {
    const rig = makeRig([]);
    expect(doorwayBlocked(rig.physics, DOOR_A)).toBe(true);
    const used = rig.world.use(hit);
    expect(used.map((e) => e.type)).toEqual(["button_press"]);
    let steps = 0;
    while (doorwayBlocked(rig.physics, DOOR_A) && steps < 200) {
      rig.stepOnce();
      steps++;
    }
    expect(steps * FIXED_DT).toBeLessThan(1.5);
    rig.run(2);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(ofType(rig.events, "door_close").length).toBe(0);
    const open = ofType(rig.events, "door_open")[0];
    expect(open.position.x).toBeCloseTo(4.15, 3);
    // Fully open: the slab has moved its whole offset.
    const item = rig.world
      .drawItems(1)
      .find((i) => Math.abs(i.transform[14] - DOOR_A.openOffset.z) < 1e-3);
    expect(item).toBeDefined();

    // Press again from the other side: it closes, once.
    rig.world.use(rayAt(LEVEL.buttons[1].position));
    rig.run(2);
    expect(ofType(rig.events, "door_close").length).toBe(1);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(doorwayBlocked(rig.physics, DOOR_A)).toBe(true);
  });

  test("use far from any button does nothing", () => {
    const rig = makeRig([]);
    expect(rig.world.use(rayAt(v3.create(0, 1, 0)))).toEqual([]);
    expect(rig.world.use(null)).toEqual([]);
    rig.run(2);
    expect(rig.events.length).toBe(0);
    expect(doorwayBlocked(rig.physics, DOOR_A)).toBe(true);
  });

  test("buttons change colour with their door", () => {
    const rig = makeRig([]);
    const colourOf = (): string[] => {
      const items = rig.world.drawItems(1);
      // Knob meshes are the only ones registered with a button material.
      return items
        .map((i) => rig.meshes[i.mesh.id].material)
        .filter((m) => m === "button_red" || m === "button_green");
    };
    expect(colourOf()).toEqual(["button_red", "button_red"]);
    rig.world.use(hit);
    rig.run(0.1);
    expect(colourOf()).toEqual(["button_green", "button_green"]);
    rig.world.use(hit);
    rig.run(0.1);
    expect(colourOf()).toEqual(["button_red", "button_red"]);
  });

  test("describe strings", () => {
    const rig = makeRig();
    expect(rig.world.describe(null)).toBeNull();
    expect(rig.world.describe(hit)).toBe("Press button");
    expect(rig.world.describe(rayAt(v3.create(0, 0, 0)))).toBeNull();
    const light = bodyTagged(rig.physics, "crate_wood_small");
    const medium = bodyTagged(rig.physics, "crate_wood");
    const heavy = bodyTagged(rig.physics, "crate_metal");
    expect(rig.world.describe(rayAt(v3.create(0, 0, 0), "body", light))).toBe(
      "Pick up",
    );
    expect(rig.world.describe(rayAt(v3.create(0, 0, 0), "body", medium))).toBe(
      "Pick up",
    );
    expect(rig.world.describe(rayAt(v3.create(0, 0, 0), "body", heavy))).toBe(
      "Too heavy",
    );
    expect(
      rig.world.describe(rayAt(v3.create(0, 0, 0), "body", 9999)),
    ).toBeNull();
    expect(rig.world.canCarry(light)).toBe(true);
    expect(rig.world.canCarry(heavy)).toBe(false);
    expect(rig.world.canCarry(9999)).toBe(false);
    expect(PROP_SPECS.barrel.mass).toBeLessThanOrEqual(PLAYER.maxCarryMass);
  });

  test("a door slab pushes aside a crate it closes on without launching it", () => {
    const rig = makeRig([
      prop("crate_wood_small", 3.7, restY("crate_wood_small"), 0),
    ]);
    rig.world.use(hit);
    rig.run(2.5);
    const crate = rig.physics.bodies()[0];
    expect(Number.isFinite(crate.position.x)).toBe(true);
    expect(v3.length(crate.linearVelocity)).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Pressure plate and door B
// ---------------------------------------------------------------------------

describe("pressure plate", () => {
  function plateRig(props: PropSpawn[]): Rig {
    return makeRig(props);
  }
  const onPlate = (kind: PropKind): Vec3 =>
    v3.create(
      PLATE_CENTRE.x,
      PLATE.box.max.y + restY(kind) + 0.001,
      PLATE_CENTRE.z,
    );

  test("nothing on it: not pressed, door shut", () => {
    const rig = plateRig([]);
    const events = rig.run(2);
    expect(events.length).toBe(0);
    expect(doorwayBlocked(rig.physics, DOOR_B)).toBe(true);
  });

  test("a 60 kg crate presses it; removing it releases it", () => {
    const rig = plateRig([prop("crate_metal", 9.5, restY("crate_metal"), 9.5)]);
    const crate = bodyTagged(rig.physics, "crate_metal");
    rig.run(0.5);
    rig.physics.setBodyPose(crate, onPlate("crate_metal"));
    const down = rig.run(0.6);
    expect(ofType(down, "plate_down").length).toBe(1);
    const position = ofType(down, "plate_down")[0].position;
    expect(position.x).toBeCloseTo(PLATE_CENTRE.x, 3);
    expect(position.y).toBeCloseTo(PLATE.box.max.y, 3);
    expect(ofType(down, "door_open").length).toBe(1);
    rig.run(2);
    expect(doorwayBlocked(rig.physics, DOOR_B)).toBe(false);
    expect(ofType(rig.events, "objective").length).toBe(1);

    rig.physics.setBodyPose(crate, v3.create(9.5, restY("crate_metal"), 9.5));
    const up = rig.run(0.6);
    expect(ofType(up, "plate_up").length).toBe(1);
    expect(ofType(up, "door_close").length).toBe(1);
    rig.run(2);
    expect(doorwayBlocked(rig.physics, DOOR_B)).toBe(true);

    // Pressing it again does not repeat the objective.
    rig.physics.setBodyPose(crate, onPlate("crate_metal"));
    rig.run(3);
    expect(ofType(rig.events, "plate_down").length).toBe(2);
    expect(ofType(rig.events, "objective").length).toBe(1);
  });

  test("the plate is drawn sunk while pressed", () => {
    const rig = plateRig([prop("crate_metal", 9.5, restY("crate_metal"), 9.5)]);
    const plateY = (): number[] =>
      rig.world
        .drawItems(1)
        .filter((i) => {
          const m = rig.meshes[i.mesh.id].material;
          return m === "pressure_plate" || m === "hazard_stripe";
        })
        .map((i) => i.transform[13]);
    const rest = plateY();
    expect(rest.length).toBe(2);
    rig.physics.setBodyPose(
      bodyTagged(rig.physics, "crate_metal"),
      onPlate("crate_metal"),
    );
    rig.run(1);
    const sunk = plateY();
    expect(rest[0] - sunk[0]).toBeCloseTo(0.025, 3);
  });

  test("a 25 kg crate is not enough; a stack of two is", () => {
    const rig = plateRig([
      prop("crate_wood", PLATE_CENTRE.x, PLATE.box.max.y + 0.4, PLATE_CENTRE.z),
    ]);
    expect(rig.run(2).length).toBe(0);
    expect(doorwayBlocked(rig.physics, DOOR_B)).toBe(true);
    // Drop a second crate on top.
    rig.physics.addBody({
      position: v3.create(
        PLATE_CENTRE.x,
        PLATE.box.max.y + 1.25,
        PLATE_CENTRE.z,
      ),
      halfExtents: PROP_SPECS.crate_wood.halfExtents,
      mass: 25,
    });
    const events = rig.run(2);
    expect(ofType(events, "plate_down").length).toBe(1);
  });

  test("the player standing on it presses it", () => {
    const rig = plateRig([]);
    const box: Aabb = {
      min: v3.create(
        PLATE_CENTRE.x - 0.3,
        PLATE.box.max.y,
        PLATE_CENTRE.z - 0.3,
      ),
      max: v3.create(
        PLATE_CENTRE.x + 0.3,
        PLATE.box.max.y + 1.8,
        PLATE_CENTRE.z + 0.3,
      ),
    };
    const events = rig.run(1, { box, mass: 80 });
    expect(ofType(events, "plate_down").length).toBe(1);
    // Jumping well off the plate (feet more than 8 cm above) releases it.
    const jumping: Aabb = {
      min: v3.create(box.min.x, PLATE.box.max.y + 0.5, box.min.z),
      max: v3.create(box.max.x, PLATE.box.max.y + 2.3, box.max.z),
    };
    const later = rig.run(1, { box: jumping, mass: 80 });
    expect(ofType(later, "plate_up").length).toBe(1);
    // A player too light does not press it.
    const lightRig = plateRig([]);
    expect(
      ofType(lightRig.run(1, { box, mass: 30 }), "plate_down").length,
    ).toBe(0);
  });

  test("a body passing over for less than the debounce does not trigger", () => {
    const rig = plateRig([prop("crate_metal", 9.5, restY("crate_metal"), 9.5)]);
    const crate = bodyTagged(rig.physics, "crate_metal");
    rig.run(0.3);
    rig.physics.setBodyPose(crate, onPlate("crate_metal"));
    for (let i = 0; i < 5; i++) {
      rig.stepOnce();
    }
    rig.physics.setBodyPose(crate, v3.create(9.5, restY("crate_metal"), 9.5));
    rig.run(1);
    expect(ofType(rig.events, "plate_down").length).toBe(0);
    expect(ofType(rig.events, "door_open").length).toBe(0);
  });

  test("a button on a plate-controlled door is denied", () => {
    const level: LevelData = {
      ...LEVEL,
      props: [],
      buttons: [{ ...LEVEL.buttons[0], target: DOOR_B.id }],
    };
    const physics = createPhysicsWorld();
    const world = createWorldObjects({
      level,
      physics,
      renderer: {
        createMesh: (m) => ({ id: m.indices.length }),
        destroyMesh() {},
      },
      seed: 1,
    });
    const events = world.use(rayAt(LEVEL.buttons[0].position));
    expect(events.map((e) => e.type)).toEqual(["button_deny"]);
  });
});

// ---------------------------------------------------------------------------
// Breakables
// ---------------------------------------------------------------------------

/** Steps until the first break event. */
function runUntilBreak(rig: Rig): void {
  for (let i = 0; i < 600; i++) {
    rig.stepOnce();
    if (ofType(rig.events, "break").length > 0) {
      return;
    }
  }
  throw new Error("nothing broke");
}

describe("breakable crate", () => {
  const spot = v3.create(9.7, 0, 13.5);

  test("setting it down gently does not break it", () => {
    const rig = makeRig([prop("crate_weak", spot.x, 0.4 + 0.03, spot.z)]);
    const events = rig.run(3);
    expect(ofType(events, "break").length).toBe(0);
    expect(rig.physics.bodies().length).toBe(1);
  });

  test("a 25 kg crate resting on it does not break it", () => {
    const rig = makeRig([
      prop("crate_weak", spot.x, 0.4, spot.z),
      prop("crate_wood", spot.x, 0.8 + 0.4 + 0.02, spot.z),
    ]);
    const events = rig.run(3);
    expect(ofType(events, "break").length).toBe(0);
    expect(rig.physics.bodies().length).toBe(2);
  });

  test("dropped from 0.3 m it survives; from 2 m it breaks", () => {
    const low = makeRig([prop("crate_weak", spot.x, 0.7, spot.z)]);
    expect(ofType(low.run(3), "break").length).toBe(0);
    const high = makeRig([prop("crate_weak", spot.x, 2.4, spot.z)]);
    expect(ofType(high.run(3), "break").length).toBe(1);
  });

  test("a hard throw into a wall breaks it into debris", () => {
    const rig = makeRig([prop("crate_weak", spot.x, 0.4, 15.4)]);
    const crate = rig.physics.bodies()[0].id;
    rig.run(0.3);
    rig.physics.setBodyVelocity(crate, v3.create(0, 0, 8));
    // Step manually to capture the crate's state at the moment it breaks.
    let before = rig.physics.getBody(crate);
    let broke = false;
    for (let i = 0; i < 90 && !broke; i++) {
      rig.physics.step(FIXED_DT);
      before = rig.physics.getBody(crate) ?? before;
      const events = rig.world.update(FIXED_DT, {
        contacts: rig.physics.drainContacts(),
        playerBox: FAR_BOX,
        playerMass: 80,
      });
      broke = ofType(events, "break").length > 0;
    }
    expect(broke).toBe(true);
    expect(rig.physics.getBody(crate)).toBeUndefined();
    const debris = rig.physics.bodies().filter((b) => b.tag === "debris");
    expect(debris.length).toBeGreaterThanOrEqual(6);
    expect(debris.length).toBeLessThanOrEqual(8);
    for (const piece of debris) {
      expect(piece.mass).toBeGreaterThanOrEqual(0.8);
      expect(piece.mass).toBeLessThanOrEqual(2);
    }
    // Pieces carry the crate's velocity plus a scatter (up 0.5..2 m/s here).
    const mean = debris.reduce(
      (sum, b) => v3.add(sum, v3.scale(b.linearVelocity, 1 / debris.length)),
      v3.create(),
    );
    const relative = v3.sub(mean, before?.linearVelocity ?? v3.create());
    expect(relative.y).toBeGreaterThan(0.2);
    expect(relative.y).toBeLessThan(2.2);
    expect(Math.hypot(relative.x, relative.z)).toBeLessThan(1.8);
    expect(
      v3.length(before?.linearVelocity ?? v3.create()),
    ).toBeGreaterThanOrEqual(0);
  });

  test("a thrown crate breaks it; a pushed one does not", () => {
    const thrown = makeRig([
      prop("crate_weak", spot.x, 0.4, spot.z),
      prop("crate_wood", spot.x, 0.4, spot.z - 1.8),
    ]);
    thrown.run(0.3);
    thrown.physics.setBodyVelocity(
      bodyTagged(thrown.physics, "crate_wood"),
      v3.create(0, 0, 8),
    );
    expect(ofType(thrown.run(2), "break").length).toBe(1);

    const pushed = makeRig([
      prop("crate_weak", spot.x, 0.4, spot.z),
      prop("crate_wood", spot.x, 0.4, spot.z - 1.8),
    ]);
    pushed.run(0.3);
    pushed.physics.setBodyVelocity(
      bodyTagged(pushed.physics, "crate_wood"),
      v3.create(0, 0, 1.5),
    );
    expect(ofType(pushed.run(2), "break").length).toBe(0);
  });

  test("debris is removed after its lifetime and unique meshes are freed", () => {
    const rig = makeRig([prop("crate_weak", spot.x, 2.4, spot.z)]);
    expect(rig.world.drawItems(1).length).toBe(1 + EXTRA_ITEMS);
    runUntilBreak(rig);
    expect(ofType(rig.events, "break").length).toBe(1);
    const withDebris = rig.world.drawItems(1).length - EXTRA_ITEMS;
    expect(withDebris).toBeGreaterThanOrEqual(6);
    expect(withDebris).toBeLessThanOrEqual(8);
    // The crate's own meshes are already gone; planks remain until expiry.
    expect(rig.freed.length).toBe(1);
    rig.run(DEBRIS_LIFETIME + 0.5);
    expect(rig.physics.bodies().length).toBe(0);
    expect(rig.world.drawItems(1).length).toBe(EXTRA_ITEMS);
    expect(rig.freed.length).toBe(1 + 3);
    expect(new Set(rig.freed).size).toBe(rig.freed.length);
  });

  test("debris shrinks over its final 0.4 s", () => {
    const rig = makeRig([prop("crate_weak", spot.x, 2.4, spot.z)]);
    runUntilBreak(rig);
    const scaleOf = (): number => {
      const m = rig.world.drawItems(1)[0].transform;
      return Math.hypot(m[0], m[1], m[2]);
    };
    expect(scaleOf()).toBeCloseTo(1, 4);
    rig.run(DEBRIS_LIFETIME - 0.2);
    expect(scaleOf()).toBeLessThan(0.7);
    expect(scaleOf()).toBeGreaterThan(0.3);
  });

  test("the break threshold is above ordinary handling", () => {
    expect(BREAK_IMPULSE).toBeGreaterThan(30);
    expect(BREAK_IMPULSE).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

describe("impacts", () => {
  function dropImpulse(kind: PropKind, height: number): WorldEvent | undefined {
    const rig = makeRig([prop(kind, 10, restY(kind) + height, 10)]);
    const events = ofType(rig.run(3), "impact");
    return events.sort((a, b) => b.impulse - a.impulse)[0];
  }

  test("a dropped crate reports its surface and a growing impulse", () => {
    const low = dropImpulse("crate_wood", 0.3);
    const high = dropImpulse("crate_wood", 1.5);
    expect(low?.type).toBe("impact");
    if (low?.type !== "impact" || high?.type !== "impact") {
      throw new Error("missing impact");
    }
    expect(low.surface).toBe("wood");
    expect(high.surface).toBe("wood");
    expect(high.impulse).toBeGreaterThan(low.impulse * 1.5);
    expect(low.position.y).toBeLessThan(0.1);
  });

  test("surfaces per kind", () => {
    const expected: Record<PropKind, SurfaceKind> = {
      crate_wood: "wood",
      crate_wood_small: "wood",
      crate_weak: "wood",
      crate_metal: "metal",
      barrel: "metal",
      chair: "plastic",
      monitor: "plastic",
    };
    for (const kind of PROP_KINDS) {
      if (kind === "crate_weak") {
        continue;
      }
      const impact = dropImpulse(kind, 0.6);
      expect(impact?.type === "impact" && impact.surface).toBe(expected[kind]);
    }
  });

  test("at most a handful of impacts per step", () => {
    const props: PropSpawn[] = [];
    for (let i = 0; i < 12; i++) {
      props.push(
        prop(
          "crate_wood_small",
          6.5 + (i % 4) * 0.8,
          0.25 + 1,
          9 + Math.floor(i / 4) * 0.8,
        ),
      );
    }
    const rig = makeRig(props);
    for (let i = 0; i < 120; i++) {
      const before = rig.events.length;
      rig.stepOnce();
      expect(rig.events.length - before).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

describe("drawItems", () => {
  test("one item per mesh part of everything", () => {
    const rig = makeRig();
    const parts: Record<PropKind, number> = {
      crate_wood: 1,
      crate_wood_small: 1,
      crate_weak: 1,
      crate_metal: 1,
      barrel: 2,
      chair: 3,
      monitor: 2,
    };
    const expected =
      LEVEL.props.reduce((sum, p) => sum + parts[p.kind], 0) +
      LEVEL.doors.length +
      LEVEL.plates.length * 2 +
      LEVEL.buttons.length * 2;
    const items = rig.world.drawItems(0.5);
    expect(items.length).toBe(expected);
    for (const item of items) {
      expect(item.mesh.id).toBeLessThan(rig.meshes.length);
      expect(item.transform.length).toBe(16);
      expect(item.transform.every(Number.isFinite)).toBe(true);
    }
  });

  test("alpha 0 and 1 give the previous and current pose", () => {
    const rig = makeRig([prop("crate_wood", 10, 2, 10, 0.4)]);
    const id = rig.physics.bodies()[0].id;
    rig.physics.setBodyVelocity(id, v3.create(1, 0, 0), v3.create(2, 1, 0.5));
    rig.stepOnce();
    const previous = rig.physics.getBody(id);
    rig.stepOnce();
    const current = rig.physics.getBody(id);
    if (!previous || !current) {
      throw new Error("missing body");
    }
    const expectMatrix = (
      matrix: Float32Array,
      pos: Vec3,
      q: typeof current.orientation,
    ): void => {
      const expected = mat4.fromTRS(pos, q);
      for (let i = 0; i < 16; i++) {
        expect(matrix[i]).toBeCloseTo(expected[i], 4);
      }
    };
    expectMatrix(
      Float32Array.from(rig.world.drawItems(0)[0].transform),
      previous.position,
      previous.orientation,
    );
    expectMatrix(
      Float32Array.from(rig.world.drawItems(1)[0].transform),
      current.position,
      current.orientation,
    );
    const mid = Float32Array.from(rig.world.drawItems(0.5)[0].transform);
    expectMatrix(
      mid,
      v3.lerp(previous.position, current.position, 0.5),
      quat.slerp(previous.orientation, current.orientation, 0.5),
    );
  });

  test("doors interpolate between steps", () => {
    const rig = makeRig([]);
    rig.world.use(rayAt(LEVEL.buttons[0].position));
    rig.run(0.5);
    const z = (alpha: number): number =>
      rig.world
        .drawItems(alpha)
        .map((i) => i.transform[14])
        .find((value) => Math.abs(value) < 1.5 && value !== 0) ?? NaN;
    rig.stepOnce();
    const a0 = z(0);
    const a1 = z(1);
    expect(a1).toBeLessThan(a0);
    expect(z(0.5)).toBeCloseTo((a0 + a1) / 2, 4);
  });

  test("bodies that fall out of the world are removed and not drawn", () => {
    const rig = makeRig([
      prop("crate_wood", 10, 2, 10),
      prop("barrel", 11, 0.45, 11),
    ]);
    const crate = rig.physics.bodies()[0].id;
    expect(rig.world.drawItems(1).length).toBe(1 + 2 + EXTRA_ITEMS);
    rig.physics.setBodyPose(crate, v3.create(10, -25, 10));
    rig.stepOnce();
    expect(rig.physics.getBody(crate)).toBeUndefined();
    expect(rig.world.drawItems(1).length).toBe(2 + EXTRA_ITEMS);
    // The crate kind has no instances left: its mesh was freed.
    expect(rig.freed).toEqual([0]);
  });

  test("reuses its result array", () => {
    const rig = makeRig([prop("crate_wood", 10, 0.4, 10)]);
    const first = rig.world.drawItems(0);
    expect(rig.world.drawItems(1)).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  function debrisSignature(seed: number): string {
    const rig = makeRig([prop("crate_weak", 9.7, 2.4, 13.5)], seed);
    rig.run(2);
    return JSON.stringify([
      rig.events,
      rig.physics
        .bodies()
        .map((b) => [b.position, b.orientation, b.linearVelocity]),
    ]);
  }

  test("the same seed gives the same debris and events", () => {
    expect(debrisSignature(5)).toBe(debrisSignature(5));
  });

  test("a different seed scatters differently", () => {
    expect(debrisSignature(5)).not.toBe(debrisSignature(6));
  });

  test("draw items exist for a whole run without errors", () => {
    const rig = makeRig();
    rig.world.use(rayAt(LEVEL.buttons[0].position));
    let last: DrawItem[] = [];
    for (let i = 0; i < 120; i++) {
      rig.stepOnce();
      last = rig.world.drawItems(i % 2 ? 0.25 : 0.75);
    }
    expect(last.length).toBeGreaterThan(20);
  });
});
