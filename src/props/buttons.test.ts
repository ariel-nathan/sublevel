import { describe, expect, test } from "bun:test";
import type {
  Aabb,
  ButtonDef,
  ContactEvent,
  DoorDef,
  KinematicMoveResult,
  LevelData,
  MeshHandle,
  PhysicsWorld,
  PropKind,
  PropSpawn,
  RayHit,
  WorldEvent,
  WorldObjects,
} from "../core/api";
import type { MeshData } from "../core/mesh";
import { PROP_SPECS } from "../core/props";
import { buildLevel } from "../level";
import { boxRects, coplanarOverlaps, describeOverlap } from "../level/coplanar";
import { v3, type Vec3 } from "../math";
import { createPhysicsWorld } from "../physics";
import { BLOCKED_PAUSE, BLOCKED_RETRY } from "./doors";
import { buttonCollider, buttonParts } from "./fixtures";
import { createWorldObjects } from "./index";
import { IMPACT_BUTTON_MIN_IMPULSE } from "./objects";
import { IMPACT_DEPTH, buildImpactButtonMeshes } from "./meshes";

const DT = 1 / 60;
const BASE = buildLevel().data;
const v = v3.create;
const FAR_BOX: Aabb = { min: v(100, 100, 100), max: v(101, 101.8, 101) };

/** Floor at y = 0 and a wall whose face is the plane z = -3. */
const FLOOR: Aabb = { min: v(-12, -1, -12), max: v(12, 0, 12) };
const WALL: Aabb = { min: v(-6, 0, -3.2), max: v(6, 4, -3) };

const WALL_POS = v(0, 0.9, -3 + IMPACT_DEPTH);
const WALL_FACING = v(0, 0, 1);

function door(id: string, x: number, z: number): DoorDef {
  return {
    id,
    closed: { min: v(x, 0, z), max: v(x + 0.2, 2.2, z + 1.4) },
    openOffset: v(0, 0, 1.6),
    material: "door_steel",
  };
}

const DOOR_1 = door("d1", 6, -3);
const DOOR_2 = door("d2", 6, 3);

/** A physics world whose door moves can be reported as blocked. */
function forcing(physics: PhysicsWorld): {
  physics: PhysicsWorld;
  /** While true, every kinematic move reports blocked and does not apply. */
  block: { on: boolean };
  /** Every position moveKinematic was asked for, with the answer given. */
  moves: { min: Vec3; blocked: boolean }[];
} {
  const block = { on: false };
  const moves: { min: Vec3; blocked: boolean }[] = [];
  const wrapped = new Proxy(physics, {
    get(target, prop) {
      if (prop === "moveKinematic") {
        return (id: number, min: Vec3): KinematicMoveResult => {
          const blocked = block.on;
          moves.push({ min: v3.clone(min), blocked });
          return blocked ? { blocked: true } : target.moveKinematic(id, min);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { physics: wrapped, block, moves };
}

interface Rig {
  physics: PhysicsWorld;
  world: WorldObjects;
  meshes: MeshData[];
  events: WorldEvent[];
  block: { on: boolean };
  moves: { min: Vec3; blocked: boolean }[];
  /** Simulated time in seconds. */
  time(): number;
  run(seconds: number): WorldEvent[];
  stepOnce(): ContactEvent[];
}

function makeRig(options: {
  buttons?: ButtonDef[];
  doors?: DoorDef[];
  plates?: LevelData["plates"];
  props?: PropSpawn[];
}): Rig {
  const level: LevelData = {
    ...BASE,
    props: options.props ?? [],
    doors: options.doors ?? [DOOR_1],
    buttons: options.buttons ?? [],
    plates: options.plates ?? [],
  };
  const real = createPhysicsWorld();
  real.addStatic(FLOOR);
  real.addStatic(WALL);
  const { physics, block, moves } = forcing(real);
  const meshes: MeshData[] = [];
  const renderer = {
    createMesh(data: MeshData): MeshHandle {
      meshes.push(data);
      return { id: meshes.length - 1 };
    },
    destroyMesh(): void {},
  };
  const world = createWorldObjects({ level, physics, renderer, seed: 3 });
  const events: WorldEvent[] = [];
  let steps = 0;
  const stepOnce = (): ContactEvent[] => {
    steps++;
    physics.step(DT);
    const contacts = physics.drainContacts();
    events.push(
      ...world.update(DT, { contacts, playerBox: FAR_BOX, playerMass: 80 }),
    );
    return contacts;
  };
  return {
    physics,
    world,
    meshes,
    events,
    block,
    moves,
    time: () => steps * DT,
    stepOnce,
    run(seconds) {
      const before = events.length;
      for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
        stepOnce();
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

function hitAt(point: Vec3): RayHit {
  return {
    collider: { kind: "static", id: 0 },
    point,
    normal: v(0, 0, 1),
    distance: 1,
  };
}

const TIMED: ButtonDef = {
  id: "timed",
  position: v(-2, 1.2, -3 + 0.06),
  facing: WALL_FACING,
  target: "d1",
  mode: "timed",
  seconds: 5,
};
const IMPACT: ButtonDef = {
  id: "impact",
  position: WALL_POS,
  facing: WALL_FACING,
  target: "d1",
  mode: "impact",
};
const TOGGLE: ButtonDef = {
  id: "toggle",
  position: v(2, 1.2, -3 + 0.06),
  facing: WALL_FACING,
  target: "d1",
};

/** Time of each event of a type, in the order they happened. */
function timesOf(
  rig: Rig,
  type: WorldEvent["type"],
  run: (onStep: () => void) => void,
): number[] {
  const times: number[] = [];
  let seen = rig.events.length;
  run(() => {
    for (; seen < rig.events.length; seen++) {
      if (rig.events[seen].type === type) {
        times.push(rig.time());
      }
    }
  });
  return times;
}

/** Steps `seconds`, calling `onStep` after each step. */
function runWith(rig: Rig, seconds: number, onStep: () => void): void {
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    rig.stepOnce();
    onStep();
  }
}

// ---------------------------------------------------------------------------
// Timed buttons
// ---------------------------------------------------------------------------

describe("timed buttons", () => {
  const press = hitAt(TIMED.position);

  test("press opens the door, then it closes after `seconds`", () => {
    const rig = makeRig({ buttons: [TIMED] });
    const used = rig.world.use(press);
    expect(used.map((e) => e.type)).toEqual(["button_press", "timer_tick"]);
    rig.run(2);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(ofType(rig.events, "door_close").length).toBe(0);
    rig.run(3.2);
    const close = ofType(rig.events, "door_close");
    expect(close.length).toBe(1);
  });

  test("closes about `seconds` after the press and not before", () => {
    const rig = makeRig({ buttons: [TIMED] });
    rig.world.use(press);
    const closes = timesOf(rig, "door_close", (onStep) =>
      runWith(rig, 8, onStep),
    );
    expect(closes.length).toBe(1);
    expect(closes[0]).toBeGreaterThanOrEqual(5 - 1e-9);
    expect(closes[0]).toBeLessThan(5 + 2 * DT);
  });

  test("default is 8 seconds", () => {
    const rig = makeRig({ buttons: [{ ...TIMED, seconds: undefined }] });
    const used = rig.world.use(press);
    expect(ofType(used, "timer_tick")[0].remaining).toBe(8);
    const closes = timesOf(rig, "door_close", (onStep) =>
      runWith(rig, 10, onStep),
    );
    expect(closes[0]).toBeGreaterThanOrEqual(8 - 1e-9);
    expect(closes[0]).toBeLessThan(8 + 2 * DT);
  });

  test("ticks once a second, then every half second in the last 3 s", () => {
    const rig = makeRig({ buttons: [{ ...TIMED, seconds: 8 }] });
    const first = rig.world.use(press);
    const ticks = ofType(first, "timer_tick").map((e) => ({
      t: 0,
      remaining: e.remaining,
    }));
    let seen = 0;
    runWith(rig, 9, () => {
      for (const e of rig.events.slice(seen)) {
        if (e.type === "timer_tick") {
          ticks.push({ t: rig.time(), remaining: e.remaining });
        }
      }
      seen = rig.events.length;
    });
    expect(ticks.map((t) => t.remaining)).toEqual([
      8, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.5,
    ]);
    // Each tick lands when that much time is left (within a step).
    for (const tick of ticks) {
      expect(Math.abs(tick.t - (8 - tick.remaining))).toBeLessThanOrEqual(
        DT + 1e-9,
      );
    }
  });

  test("tick events carry the door position and none follow the close", () => {
    const rig = makeRig({ buttons: [TIMED] });
    rig.world.use(press);
    rig.run(7);
    const centre = v3.scale(v3.add(DOOR_1.closed.min, DOOR_1.closed.max), 0.5);
    for (const tick of ofType(rig.events, "timer_tick")) {
      expect(tick.position.x).toBeCloseTo(centre.x, 6);
      expect(tick.remaining).toBeGreaterThan(0);
    }
    const count = ofType(rig.events, "timer_tick").length;
    rig.run(3);
    expect(ofType(rig.events, "timer_tick").length).toBe(count);
  });

  test("pressing again while open restarts the countdown", () => {
    const rig = makeRig({ buttons: [TIMED] });
    rig.world.use(press);
    rig.run(3);
    const again = rig.world.use(press);
    expect(again.map((e) => e.type)).toEqual(["button_press", "timer_tick"]);
    expect(ofType(again, "timer_tick")[0].remaining).toBe(5);
    rig.run(3);
    // 6 s after the first press, but only 3 s after the second.
    expect(ofType(rig.events, "door_close").length).toBe(0);
    rig.run(2.2);
    expect(ofType(rig.events, "door_close").length).toBe(1);
    expect(ofType(rig.events, "door_open").length).toBe(1);
  });

  test("the button is green while the door is open and red otherwise", () => {
    const rig = makeRig({ buttons: [TIMED] });
    const colour = (): string[] =>
      rig.world
        .drawItems(1)
        .map((i) => rig.meshes[i.mesh.id].material)
        .filter((m) => m === "button_red" || m === "button_green");
    expect(colour()).toEqual(["button_red"]);
    rig.world.use(press);
    rig.run(0.1);
    expect(colour()).toEqual(["button_green"]);
    rig.run(5.5);
    expect(colour()).toEqual(["button_red"]);
  });

  test("describe says Press timer", () => {
    const rig = makeRig({ buttons: [TIMED, TOGGLE, IMPACT] });
    expect(rig.world.describe(press)).toBe("Press timer");
    expect(rig.world.describe(hitAt(TOGGLE.position))).toBe("Press button");
    expect(rig.world.describe(hitAt(IMPACT.position))).toBe("Out of reach");
  });

  test("a pressed plate keeps the door open after the countdown ends", () => {
    const plate = {
      id: "p",
      box: { min: v(3, 0, 3), max: v(4.2, 0.04, 4.2) },
      requiredMass: 20,
      target: "d1",
    };
    const rig = makeRig({
      buttons: [TIMED],
      plates: [plate],
      props: [
        {
          kind: "crate_wood" as PropKind,
          position: v(3.6, 0.04 + PROP_SPECS.crate_wood.halfExtents.y, 3.6),
          yaw: 0,
        },
      ],
    });
    rig.world.use(press);
    rig.run(8);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(ofType(rig.events, "door_close").length).toBe(0);
    // The countdown still ran: ticks stopped at the end.
    expect(ofType(rig.events, "timer_tick").length).toBe(7);
    // Release the plate: the door closes (the countdown is long over).
    rig.physics.setBodyPose(rig.physics.bodies()[0].id, v(-4, 0.4, 2));
    rig.run(1);
    expect(ofType(rig.events, "door_close").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Impact buttons
// ---------------------------------------------------------------------------

/** A prop thrown at the button from 1.5 m in front of it. */
function thrown(kind: PropKind): PropSpawn {
  return {
    kind,
    position: v(
      0,
      WALL_POS.y,
      -3 + IMPACT_DEPTH + PROP_SPECS[kind].halfExtents.z + 1.5,
    ),
    yaw: 0,
  };
}

function throwAtButton(
  rig: Rig,
  kind: PropKind,
  speed: number,
  lift = 0,
): number {
  const body = rig.physics.bodies().find((b) => b.tag === kind);
  if (!body) {
    throw new Error("no body");
  }
  // A little lift cancels the drop over the 1.5 m flight.
  const flight = 1.5 / speed;
  rig.physics.setBodyVelocity(body.id, v(0, 4.905 * flight + lift, -speed));
  return body.id;
}

describe("impact buttons", () => {
  const use = hitAt(IMPACT.position);

  function throwRig(kind: PropKind, speed: number): Rig {
    const rig = makeRig({
      buttons: [IMPACT],
      props: [thrown(kind)],
    });
    // Let the prop settle in the air for the world's settle window first.
    rig.run(0.1);
    // Gravity has pulled it a little; throw it level.
    const body = rig.physics.bodies()[0];
    rig.physics.setBodyPose(
      body.id,
      v(0, WALL_POS.y, body.position.z),
      body.orientation,
    );
    throwAtButton(rig, kind, speed);
    return rig;
  }

  test("use is denied and describe is a short label", () => {
    const rig = makeRig({ buttons: [IMPACT] });
    expect(rig.world.use(use).map((e) => e.type)).toEqual(["button_deny"]);
    rig.run(2);
    expect(ofType(rig.events, "door_open").length).toBe(0);
    expect(rig.world.describe(use)).toBe("Out of reach");
  });

  const cases: [string, PropKind, number][] = [
    ["thrown small crate at 8 m/s", "crate_wood_small", 8],
    ["thrown small crate at 11 m/s", "crate_wood_small", 11],
    ["thrown 25 kg crate at 7 m/s", "crate_wood", 7],
    ["thrown chair at 8 m/s", "chair", 8],
  ];
  for (const [name, kind, speed] of cases) {
    test(`${name} triggers it`, () => {
      const rig = throwRig(kind, speed);
      rig.run(1.5);
      const presses = ofType(rig.events, "button_press");
      expect(presses.length).toBe(1);
      expect(presses[0].position.z).toBeCloseTo(WALL_POS.z, 6);
      expect(ofType(rig.events, "door_open").length).toBe(1);
    });
  }

  test("slow pushes and brushes do not trigger it", () => {
    for (const [kind, speed] of [
      ["crate_wood", 1],
      ["crate_metal", 1.5],
      ["barrel", 2],
      ["crate_wood_small", 2],
    ] as [PropKind, number][]) {
      const rig = throwRig(kind, speed);
      rig.run(2);
      expect(ofType(rig.events, "button_press").length).toBe(0);
      expect(ofType(rig.events, "door_open").length).toBe(0);
    }
  });

  test("a prop resting against it does not trigger it", () => {
    const half = PROP_SPECS.crate_metal.halfExtents;
    const rig = makeRig({
      buttons: [{ ...IMPACT, position: v(0, 0.2, -3 + IMPACT_DEPTH) }],
      props: [
        {
          kind: "crate_metal",
          position: v(0, half.y, -3 + IMPACT_DEPTH + half.z + 0.001),
          yaw: 0,
        },
      ],
    });
    rig.run(5);
    expect(ofType(rig.events, "button_press").length).toBe(0);
  });

  test("a prop brushing past along the wall does not trigger it", () => {
    const half = PROP_SPECS.crate_wood.halfExtents;
    const rig = makeRig({
      buttons: [{ ...IMPACT, position: v(0, 0.4, -3 + IMPACT_DEPTH) }],
      props: [
        {
          kind: "crate_wood",
          position: v(-3, half.y, -3 + IMPACT_DEPTH + half.z + 0.002),
          yaw: 0,
        },
      ],
    });
    rig.run(0.2);
    rig.physics.setBodyVelocity(rig.physics.bodies()[0].id, v(6, 0, 0));
    rig.run(2);
    expect(ofType(rig.events, "button_press").length).toBe(0);
  });

  test("broken-crate debris thrown at it does not trigger it", () => {
    const rig = makeRig({
      buttons: [IMPACT],
      props: [
        { kind: "crate_weak", position: v(2, 0.4, -1), yaw: 0 },
        { kind: "crate_metal", position: v(2, 0.35, 1.5), yaw: 0 },
      ],
    });
    rig.run(0.3);
    const weak = rig.physics.bodies().find((b) => b.tag === "crate_weak")!;
    rig.physics.setBodyVelocity(weak.id, v(0, 0, 9));
    rig.physics.setBodyPose(weak.id, v(2, 0.4, 1.0));
    rig.run(0.8);
    expect(ofType(rig.events, "break").length).toBeGreaterThan(0);
    const debris = rig.physics.bodies().filter((b) => b.tag === "debris");
    expect(debris.length).toBeGreaterThan(0);
    for (const piece of debris) {
      rig.physics.setBodyPose(piece.id, v(0, WALL_POS.y, -1.5));
      rig.physics.setBodyVelocity(piece.id, v(0, 0, -12));
    }
    rig.run(1);
    expect(ofType(rig.events, "button_press").length).toBe(0);
  });

  test("it latches: the door never closes and further hits do nothing", () => {
    const rig = throwRig("crate_wood_small", 9);
    rig.run(2);
    expect(ofType(rig.events, "button_press").length).toBe(1);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    // Hit it again.
    const body = rig.physics.bodies()[0];
    rig.physics.setBodyPose(body.id, v(0, WALL_POS.y, -1.5));
    rig.physics.setBodyVelocity(body.id, v(0, 0, -9));
    rig.run(20);
    expect(ofType(rig.events, "button_press").length).toBe(1);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(ofType(rig.events, "door_close").length).toBe(0);
  });

  test("the knob turns green when hit", () => {
    const rig = throwRig("crate_wood", 7);
    const colour = (): string[] =>
      rig.world
        .drawItems(1)
        .map((i) => rig.meshes[i.mesh.id].material)
        .filter((m) => m === "button_red" || m === "button_green");
    expect(colour()).toEqual(["button_red"]);
    rig.run(1.5);
    expect(colour()).toEqual(["button_green"]);
  });

  test("the unit is drawn from stripe, inset and knob", () => {
    const rig = makeRig({ buttons: [IMPACT, TOGGLE] });
    const items = rig.world.drawItems(1);
    const materials = items.map((i) => rig.meshes[i.mesh.id].material);
    expect(materials.filter((m) => m === "hazard_stripe").length).toBe(1);
    expect(items.length).toBe(1 + 2 /* door + toggle bezel and knob */ + 3);
  });

  test("the threshold sits between resting contact and a light throw", () => {
    // Resting: m g dt for the heaviest prop (60 kg) is under 10 N·s.
    expect(60 * 9.81 * DT).toBeLessThan(IMPACT_BUTTON_MIN_IMPULSE);
    // A chair thrown at 4 m/s (barely a throw) already gives more.
    expect(PROP_SPECS.chair.mass * 4 + 5).toBeGreaterThan(
      IMPACT_BUTTON_MIN_IMPULSE,
    );
  });
});

// ---------------------------------------------------------------------------
// Impact button unit geometry
// ---------------------------------------------------------------------------

describe("impact button unit", () => {
  const wallRects = (): ReturnType<typeof boxRects> =>
    boxRects("wall", WALL.min, WALL.max, []);

  test("meshes are valid, wind outward and stay inside the unit bounds", () => {
    const meshes = buildImpactButtonMeshes();
    for (const mesh of [
      meshes.stripe,
      meshes.inset,
      meshes.red,
      meshes.green,
    ]) {
      const n = mesh.positions.length / 3;
      expect(mesh.indices.length % 3).toBe(0);
      for (const index of mesh.indices) {
        expect(index).toBeLessThan(n);
      }
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const p = [0, 1, 2].map((k) => {
          const j = mesh.indices[i + k] * 3;
          return v(
            mesh.positions[j],
            mesh.positions[j + 1],
            mesh.positions[j + 2],
          );
        });
        const face = v3.normalize(
          v3.cross(v3.sub(p[1], p[0]), v3.sub(p[2], p[0])),
        );
        const j = mesh.indices[i] * 3;
        const normal = v(
          mesh.normals[j],
          mesh.normals[j + 1],
          mesh.normals[j + 2],
        );
        expect(v3.dot(face, normal)).toBeGreaterThan(0.5);
      }
    }
    const xs: number[] = [];
    const zs: number[] = [];
    for (const mesh of [meshes.stripe, meshes.inset, meshes.red]) {
      for (let i = 0; i < mesh.positions.length; i += 3) {
        xs.push(Math.abs(mesh.positions[i]));
        zs.push(mesh.positions[i + 2]);
      }
    }
    expect(Math.max(...xs)).toBeCloseTo(0.17, 6);
    expect(Math.max(...zs)).toBeCloseTo(0, 6);
    expect(Math.min(...zs)).toBeCloseTo(-IMPACT_DEPTH - 0.01, 6);
  });

  test("it is larger than a wall button and uses a hazard stripe", () => {
    const parts = buttonParts(IMPACT);
    const [bezel] = parts;
    expect(bezel.box.max.x - bezel.box.min.x).toBeCloseTo(0.34, 6);
    expect(
      buttonParts(TOGGLE)[0].box.max.x - buttonParts(TOGGLE)[0].box.min.x,
    ).toBeCloseTo(0.22, 6);
    expect(buildImpactButtonMeshes().stripe.material).toBe("hazard_stripe");
  });

  test("the lit knob's cap is the button face and every part is >= 5 mm proud with no coplanar faces against the wall", () => {
    const parts = buttonParts(IMPACT);
    const found = coplanarOverlaps(
      parts.flatMap((p) => boxRects(p.owner, p.box.min, p.box.max, p.skip)),
      wallRects(),
    ).map(describeOverlap);
    expect(found).toEqual([]);
    const wallZ = -3;
    for (const part of parts) {
      expect(part.box.max.z - wallZ).toBeGreaterThanOrEqual(0.005);
      expect(Math.abs(part.box.min.z - wallZ)).toBeGreaterThanOrEqual(0.005);
    }
    const knob = parts.find((p) => p.owner.endsWith("knob"))!;
    expect(knob.box.max.z).toBeCloseTo(IMPACT.position.z, 9);
  });

  test("its parts share no plane with each other", () => {
    const parts = buttonParts(IMPACT);
    const rects = parts.flatMap((p) =>
      boxRects(p.owner, p.box.min, p.box.max, p.skip),
    );
    expect(coplanarOverlaps(rects).map(describeOverlap)).toEqual([]);
  });

  test("the collider covers the visible unit and a ray hits it", () => {
    const c = buttonCollider(IMPACT);
    const bezel = buttonParts(IMPACT)[0].box;
    expect(c.min.x).toBeCloseTo(bezel.min.x, 9);
    expect(c.max.x).toBeCloseTo(bezel.max.x, 9);
    expect(c.max.z).toBeCloseTo(IMPACT.position.z, 9);
    const rig = makeRig({ buttons: [IMPACT] });
    for (const [dx, dy] of [
      [0, 0],
      [0.15, 0.15],
      [-0.15, -0.15],
    ]) {
      const origin = v(IMPACT.position.x + dx, IMPACT.position.y + dy, -1);
      const hit = rig.physics.raycast(origin, v(0, 0, -1), 5);
      expect(hit).not.toBeNull();
      expect(hit!.point.z).toBeCloseTo(IMPACT.position.z, 4);
      expect(hit!.collider.kind).toBe("static");
    }
    // Just outside the bezel the ray reaches the wall instead.
    const miss = rig.physics.raycast(
      v(IMPACT.position.x + 0.2, IMPACT.position.y, -1),
      v(0, 0, -1),
      5,
    );
    expect(miss!.point.z).toBeCloseTo(-3, 4);
  });
});

// ---------------------------------------------------------------------------
// Doors reverse when blocked
// ---------------------------------------------------------------------------

describe("blocked doors", () => {
  const T: ButtonDef = { ...TOGGLE };
  const hit = hitAt(T.position);
  const travelOf = (rig: Rig): number =>
    // The door's slab centre along z, relative to closed.
    rig.world.drawItems(1)[0].transform[14] -
    (DOOR_1.closed.min.z + DOOR_1.closed.max.z) / 2;

  function openedRig(): Rig {
    const rig = makeRig({ buttons: [T] });
    rig.world.use(hit);
    rig.run(2.5);
    return rig;
  }

  test("a closing door stops, reports once per attempt, reopens, retries and finally closes", () => {
    const rig = openedRig();
    rig.world.use(hit); // wants closed
    rig.block.on = true;
    const blocked = timesOf(rig, "door_blocked", (onStep) =>
      runWith(rig, 9, onStep),
    );
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    // Attempts are at least a pause plus a retry interval apart.
    for (let i = 1; i < blocked.length; i++) {
      expect(blocked[i] - blocked[i - 1]).toBeGreaterThanOrEqual(
        BLOCKED_PAUSE + BLOCKED_RETRY,
      );
    }
    // Each block is followed by one reopen (plus the very first opening),
    // and each attempt had one close.
    expect(ofType(rig.events, "door_open").length).toBe(1 + blocked.length);
    expect(ofType(rig.events, "door_close").length).toBeGreaterThanOrEqual(
      blocked.length,
    );
    // The obstruction goes away: the next attempt gets through.
    rig.block.on = false;
    rig.run(6);
    expect(travelOf(rig)).toBeCloseTo(0, 6);
    const blockedAfter = ofType(rig.events, "door_blocked").length;
    rig.run(4);
    expect(ofType(rig.events, "door_blocked").length).toBe(blockedAfter);
  });

  test("timing: pause 0.4 s, reopen, retry 1.5 s after fully open", () => {
    const rig = openedRig();
    const t0 = rig.time();
    rig.world.use(hit);
    rig.block.on = true;
    const events: { type: string; t: number }[] = [];
    let seen = rig.events.length;
    runWith(rig, 6, () => {
      for (const e of rig.events.slice(seen)) {
        events.push({ type: e.type, t: rig.time() - t0 });
      }
      seen = rig.events.length;
    });
    const types = events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "door_close",
      "door_blocked",
      "door_open",
      "door_close",
    ]);
    // Blocked on the first closing step, reopened BLOCKED_PAUSE later.
    expect(events[1].t).toBeLessThanOrEqual(2 * DT);
    const gap = events[2].t - events[1].t;
    expect(gap).toBeGreaterThanOrEqual(BLOCKED_PAUSE - 1e-9);
    expect(gap).toBeLessThan(BLOCKED_PAUSE + 2 * DT);
    // Almost nothing to reopen, then BLOCKED_RETRY before the next attempt.
    const retry = events[3].t - events[2].t;
    expect(retry).toBeGreaterThanOrEqual(BLOCKED_RETRY);
    expect(retry).toBeLessThan(BLOCKED_RETRY + 0.3);
  });

  test("while it is wanted open, nothing is retried", () => {
    const rig = openedRig();
    rig.block.on = true;
    rig.run(8);
    expect(ofType(rig.events, "door_blocked").length).toBe(0);
    expect(ofType(rig.events, "door_close").length).toBe(0);
  });

  test("an opening door ignores blocked", () => {
    const rig = makeRig({ buttons: [T] });
    rig.block.on = true;
    rig.world.use(hit);
    rig.run(3);
    expect(ofType(rig.events, "door_blocked").length).toBe(0);
    expect(ofType(rig.events, "door_open").length).toBe(1);
    expect(travelOf(rig)).toBeCloseTo(1.6, 3);
  });

  test("the slab never passes the point where a move was refused", () => {
    const rig = openedRig();
    rig.world.use(hit);
    // Let it close part way, then block.
    runWith(rig, 0.4, () => {});
    const before = travelOf(rig);
    expect(before).toBeGreaterThan(0.3);
    expect(before).toBeLessThan(1.5);
    rig.block.on = true;
    let lowest = Infinity;
    runWith(rig, 10, () => {
      lowest = Math.min(lowest, travelOf(rig));
    });
    expect(lowest).toBeGreaterThanOrEqual(before - 1e-9);
    expect(rig.moves.some((m) => m.blocked)).toBe(true);
  });

  test("a timed door held open by an obstruction keeps its countdown at zero", () => {
    const rig = makeRig({ buttons: [{ ...TIMED, seconds: 3 }] });
    rig.world.use(hitAt(TIMED.position));
    rig.block.on = true;
    rig.run(3.5);
    const ticksAfterExpiry = ofType(rig.events, "timer_tick").length;
    expect(ofType(rig.events, "timer_tick").every((t) => t.remaining > 0)).toBe(
      true,
    );
    rig.run(8);
    expect(ofType(rig.events, "timer_tick").length).toBe(ticksAfterExpiry);
    expect(ofType(rig.events, "door_blocked").length).toBeGreaterThan(0);
    rig.block.on = false;
    rig.run(6);
    expect(travelOf(rig)).toBeCloseTo(0, 6);
  });

  test("no event spam over 10 s of continuous blocking", () => {
    const rig = openedRig();
    rig.world.use(hit);
    rig.block.on = true;
    const before = rig.events.length;
    rig.run(10);
    const fresh = rig.events.slice(before);
    const blocks = ofType(fresh, "door_blocked").length;
    // One attempt every ~2 s when the slab has hardly moved.
    expect(blocks).toBeLessThanOrEqual(6);
    // Per attempt: one close, one blocked, one open: nothing else.
    expect(fresh.length).toBeLessThanOrEqual(3 * 6);
    expect(
      fresh.every((e) =>
        ["door_close", "door_blocked", "door_open"].includes(e.type),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the existing level
// ---------------------------------------------------------------------------

describe("determinism", () => {
  function trace(): string {
    const rig = makeRig({
      buttons: [TIMED, IMPACT],
      doors: [DOOR_1, DOOR_2],
      props: [
        {
          kind: "crate_wood_small",
          position: v(0, WALL_POS.y, -1),
          yaw: 0.3,
        },
      ],
    });
    rig.world.use(hitAt(TIMED.position));
    rig.run(0.2);
    rig.physics.setBodyVelocity(rig.physics.bodies()[0].id, v(0, 0, -9));
    rig.block.on = false;
    rig.run(12);
    return JSON.stringify(rig.events);
  }

  test("the same inputs give the same events", () => {
    expect(trace()).toBe(trace());
  });
});
