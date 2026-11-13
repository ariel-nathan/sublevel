/**
 * The assembler: places room modules one after another, each built from an
 * exit of one placed before it, and gathers what they build into one
 * `LevelData`, checking the rules of src/level/rooms/room.ts as it goes.
 * Every violation throws an Error naming the placement and the rule.
 */
import type {
  AcousticZone,
  Brush,
  ButtonDef,
  Color,
  DoorDef,
  Fog,
  LevelData,
  LightDef,
  PressurePlateDef,
  PropSpawn,
  SolutionStep,
  SoundEmitterDef,
} from "../core/api";
import { PROP_SPECS } from "../core/props";
import { createRng } from "../core/rng";
import type { Vec3 } from "../math";
import {
  boxesOverlap,
  boxOf,
  BoxIndex,
  containsPoint,
  propBox,
  regionCovered,
  type Box,
} from "./geometry";
import {
  doorwayPoints,
  LIGHT_REACH,
  rectWithin,
  ZONE_REACH,
  type AnyRoomModule,
  type Connector,
  type Doorway,
  type RoomContext,
  type RoomModule,
  type RoomPlan,
} from "./rooms/room";

/** One module placed in a level. */
export interface Placement {
  module: AnyRoomModule;
  /** Instance name, unique in the level. */
  name: string;
  /** Default: the module's defaults. */
  params?: unknown;
  /** Seed of the module's rng (default 0). */
  seed?: number;
  /** Build it mirrored left to right. */
  mirror?: boolean;
  /**
   * Prefix of the module's door, button and plate ids. Default
   * `${name}.`; a hand-built level whose ids are unique anyway may pass "".
   */
  prefix?: string;
  /**
   * Which exit of which earlier placement this one is built from. Default:
   * exit 0 of the placement just before. Ignored for the first placement.
   */
  attach?: { to: number; exit: number };
}

/** A placement whose parameters are type-checked against its module. */
export function place<P>(
  module: RoomModule<P>,
  placement: Omit<Placement, "module" | "params"> & { params?: P },
): Placement {
  return { ...placement, module };
}

export interface LevelPlan {
  name: string;
  /** Where the first (start) module is anchored: its `at` connector. */
  root: { position: Vec3; facing: Vec3 };
  placements: Placement[];
  ambient: Color;
  fog: Fog;
  seed: number | null;
}

/** What a module built, before it is added to the level. */
export interface RoomParts {
  brushes: Brush[];
  lights: LightDef[];
  props: PropSpawn[];
  doors: DoorDef[];
  buttons: ButtonDef[];
  plates: PressurePlateDef[];
  emitters: SoundEmitterDef[];
  zones: AcousticZone[];
}

export interface PlacedRoom {
  name: string;
  module: AnyRoomModule;
  /** The connector it was built from (the root anchor for a start module). */
  at: Connector;
  plan: RoomPlan;
  parts: RoomParts;
  /** Index of its first prop in `LevelData.props`. */
  propOffset: number;
}

export interface AssembledLevel {
  data: LevelData;
  rooms: PlacedRoom[];
}

const emptyParts = (): RoomParts => ({
  brushes: [],
  lights: [],
  props: [],
  doors: [],
  buttons: [],
  plates: [],
  emitters: [],
  zones: [],
});

/**
 * Builds one module into a fresh set of parts. With `discard` nothing is
 * kept: that is planning (footprint, exits, lock and solution) without
 * building, and gives exactly the plan that building would.
 */
export function buildRoom(
  module: AnyRoomModule,
  at: Connector,
  options: {
    params?: unknown;
    seed?: number;
    mirror?: boolean;
    prefix?: string;
  } = {},
): { plan: RoomPlan; parts: RoomParts } {
  const parts = emptyParts();
  const prefix = options.prefix ?? "";
  const ctx: RoomContext = {
    rng: createRng(options.seed ?? 0),
    mirror: options.mirror ?? false,
    id: (local) => `${prefix}${local}`,
    box(min, max, material) {
      parts.brushes.push({ min: { ...min }, max: { ...max }, material });
    },
    light: (def) => void parts.lights.push(def),
    prop(kind, base, yaw) {
      parts.props.push({
        kind,
        position: {
          x: base.x,
          y: base.y + PROP_SPECS[kind].halfExtents.y,
          z: base.z,
        },
        yaw,
      });
      return parts.props.length - 1;
    },
    door: (def) => void parts.doors.push(def),
    button: (def) => void parts.buttons.push(def),
    plate: (def) => void parts.plates.push(def),
    emitter: (def) => void parts.emitters.push(def),
    zone: (zone) => void parts.zones.push(zone),
  };
  const plan = module.build(ctx, at, options.params ?? module.defaults);
  return { plan, parts };
}

/** A module's plan for an entry, without keeping what it builds. */
export function planRoom(
  module: AnyRoomModule,
  at: Connector,
  options: Parameters<typeof buildRoom>[2] = {},
): RoomPlan {
  return buildRoom(module, at, options).plan;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const EPS = 1e-6;

/** The footprint's union, plus a slab `reach` deep across each doorway. */
function allowedRegion(plan: RoomPlan, reach: number): Box[] {
  const boxes = plan.footprint.map(boxOf);
  if (reach <= 0) return boxes;
  const all = boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    z1: Math.max(a.z1, b.z1),
  }));
  const doorways: { c: Connector; out: number }[] = [
    ...(plan.entry ? [{ c: plan.entry.connector, out: -1 }] : []),
    ...plan.exits.map((e) => ({ c: e.connector, out: 1 })),
  ];
  for (const { c, out } of doorways) {
    const dx = c.facing.x * out;
    const dz = c.facing.z * out;
    const slab = { ...all };
    if (dx !== 0) {
      slab.x0 = dx > 0 ? c.position.x : c.position.x - reach;
      slab.x1 = dx > 0 ? c.position.x + reach : c.position.x;
    } else {
      slab.z0 = dz > 0 ? c.position.z : c.position.z - reach;
      slab.z1 = dz > 0 ? c.position.z + reach : c.position.z;
    }
    boxes.push(slab);
  }
  return boxes;
}

function inside(region: Box[], b: Box): boolean {
  const shrunk = {
    x0: b.x0 + EPS,
    y0: b.y0 + EPS,
    z0: b.z0 + EPS,
    x1: b.x1 - EPS,
    y1: b.y1 - EPS,
    z1: b.z1 - EPS,
  };
  if (
    shrunk.x0 >= shrunk.x1 ||
    shrunk.y0 >= shrunk.y1 ||
    shrunk.z0 >= shrunk.z1
  )
    return region.some((r) =>
      containsPoint(r, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2),
    );
  if (region.some((r) => containsBox(r, b))) return true;
  return regionCovered(new BoxIndex(region), region, shrunk);
}

function containsBox(outer: Box, b: Box): boolean {
  return (
    b.x0 >= outer.x0 - EPS &&
    b.x1 <= outer.x1 + EPS &&
    b.y0 >= outer.y0 - EPS &&
    b.y1 <= outer.y1 + EPS &&
    b.z0 >= outer.z0 - EPS &&
    b.z1 <= outer.z1 + EPS
  );
}

const pointBox = (p: Vec3): Box => ({
  x0: p.x,
  y0: p.y,
  z0: p.z,
  x1: p.x,
  y1: p.y,
  z1: p.z,
});

const shifted = (b: Box, o: Vec3): Box => ({
  x0: b.x0 + o.x,
  x1: b.x1 + o.x,
  y0: b.y0 + o.y,
  y1: b.y1 + o.y,
  z0: b.z0 + o.z,
  z1: b.z1 + o.z,
});

const fmtBox = (b: Box): string =>
  `(${[b.x0, b.y0, b.z0].map((v) => v.toFixed(3)).join(", ")})..(${[b.x1, b.y1, b.z1].map((v) => v.toFixed(3)).join(", ")})`;

/**
 * Everything the module emitted lies inside its footprint (zones and
 * dynamic light bounds may reach a little across its doorways). Returns
 * the violations, empty if none.
 */
export function outsideFootprint(plan: RoomPlan, parts: RoomParts): string[] {
  const region = allowedRegion(plan, 0);
  const lightRegion = allowedRegion(plan, LIGHT_REACH);
  const zoneRegion = allowedRegion(plan, ZONE_REACH);
  const out: string[] = [];
  const need = (ok: boolean, what: string, b: Box) => {
    if (!ok) out.push(`${what} ${fmtBox(b)} is outside the footprint`);
  };
  parts.brushes.forEach((brush, i) => {
    const b = boxOf(brush);
    need(inside(region, b), `brush #${i} (${brush.material})`, b);
  });
  parts.props.forEach((p, i) => {
    const b = propBox(p);
    need(inside(region, b), `prop #${i} (${p.kind})`, b);
  });
  for (const d of parts.doors) {
    const b = boxOf(d.closed);
    need(inside(region, b), `door ${d.id}`, b);
    const open = shifted(b, d.openOffset);
    need(inside(region, open), `door ${d.id} when open`, open);
  }
  for (const btn of parts.buttons) {
    const b = pointBox(btn.position);
    need(inside(region, b), `button ${btn.id}`, b);
  }
  for (const p of parts.plates) {
    const b = boxOf(p.box);
    need(inside(region, b), `plate ${p.id}`, b);
  }
  for (const e of parts.emitters) {
    const b = pointBox(e.position);
    need(inside(region, b), `emitter ${e.sound}`, b);
  }
  parts.lights.forEach((l, i) => {
    const b = pointBox(l.position);
    need(inside(region, b), `light #${i}`, b);
    if (l.bounds) {
      const lb = boxOf(l.bounds);
      need(inside(lightRegion, lb), `bounds of light #${i}`, lb);
    }
  });
  parts.zones.forEach((z, i) => {
    const b = boxOf(z.box);
    need(inside(zoneRegion, b), `zone #${i} (${z.room})`, b);
  });
  if (plan.spawn) {
    const b = pointBox(plan.spawn.position);
    need(inside(region, b), "spawn", b);
  }
  if (plan.exit) {
    const b = boxOf(plan.exit);
    need(inside(region, b), "exit box", b);
  }
  return out;
}

const sameVec = (a: Vec3, b: Vec3): boolean =>
  Math.abs(a.x - b.x) < EPS &&
  Math.abs(a.y - b.y) < EPS &&
  Math.abs(a.z - b.z) < EPS;

/** Why the two ends of a doorway cannot meet, or null if they can. */
export function jointProblem(exit: Doorway, entry: Doorway): string | null {
  const a = exit.connector;
  const b = entry.connector;
  if (
    !sameVec(a.position, b.position) ||
    !sameVec(a.facing, b.facing) ||
    Math.abs(a.width - b.width) > EPS ||
    Math.abs(a.height - b.height) > EPS
  ) {
    return "the entry it reports is not the connector it was built from";
  }
  if (!exit.end.wall && !entry.end.wall) {
    return "two open ends meet: neither side has a wall";
  }
  if (a.door !== undefined && !exit.end.wall) {
    return "the exit has a door but no wall of its own to hold it";
  }
  if (!exit.end.wall && !rectWithin(exit.end.extent, entry.end.extent)) {
    return "the exit's open end is not covered by the entry's wall";
  }
  if (!entry.end.wall && !rectWithin(entry.end.extent, exit.end.extent)) {
    return "the entry's open end is not covered by the exit's wall";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function remap(step: SolutionStep, offset: number): SolutionStep {
  return "prop" in step ? { ...step, prop: step.prop + offset } : step;
}

export function assembleLevel(level: LevelPlan): AssembledLevel {
  const data: LevelData = {
    name: level.name,
    brushes: [],
    lights: [],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    props: [],
    doors: [],
    buttons: [],
    plates: [],
    emitters: [],
    ambient: level.ambient,
    fog: level.fog,
    exit: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    zones: [],
    seed: level.seed,
    solution: [],
  };
  const rooms: PlacedRoom[] = [];
  const used = new Set<string>();
  const names = new Set<string>();
  const ids = new Set<string>();
  let start = -1;
  let finish = -1;

  level.placements.forEach((p, index) => {
    const where = `placement ${index} "${p.name}" (${p.module.name})`;
    const fail = (why: string): never => {
      throw new Error(`${where}: ${why}`);
    };
    if (names.has(p.name)) fail("the name is already used");
    names.add(p.name);
    const role = p.module.role;
    if ((index === 0) !== (role === "start")) {
      fail(
        index === 0
          ? "the first placement must be a start module"
          : "only the first placement can be a start module",
      );
    }

    let at: Connector;
    let from: { room: number; exit: number } | null = null;
    if (index === 0) {
      at = { ...level.root, width: 0, height: 0 };
    } else {
      const attach = p.attach ?? { to: index - 1, exit: 0 };
      if (attach.to < 0 || attach.to >= index) {
        fail(`attaches to placement ${attach.to}, which is not before it`);
      }
      const prev = rooms[attach.to];
      const exit = prev.plan.exits[attach.exit];
      if (!exit) fail(`"${prev.name}" has no exit ${attach.exit}`);
      const key = `${attach.to}:${attach.exit}`;
      if (used.has(key)) {
        fail(`exit ${attach.exit} of "${prev.name}" is already used`);
      }
      used.add(key);
      at = exit.connector;
      from = { room: attach.to, exit: attach.exit };
      const [w0, w1] = p.module.entrySize.width;
      const [h0, h1] = p.module.entrySize.height;
      if (
        at.width < w0 - EPS ||
        at.width > w1 + EPS ||
        at.height < h0 - EPS ||
        at.height > h1 + EPS
      ) {
        fail(
          `connector size mismatch: the doorway from "${prev.name}" is ${at.width} x ${at.height} m, the module takes ${w0}-${w1} x ${h0}-${h1} m`,
        );
      }
    }

    const { plan, parts } = buildRoom(p.module, at, {
      params: p.params,
      seed: p.seed,
      mirror: p.mirror,
      prefix: p.prefix ?? `${p.name}.`,
    });

    // The module's own declarations.
    if (role === "start" && (plan.entry !== null || !plan.spawn)) {
      fail("a start module has no entry and declares a spawn");
    }
    if (role !== "start" && plan.entry === null) fail("it reports no entry");
    if (role === "finish" && (plan.exits.length > 0 || !plan.exit)) {
      fail("a finish module has no exits and declares an exit box");
    }
    if (role === "middle" && plan.exits.length === 0) fail("it has no exit");
    if (plan.footprint.length === 0) fail("it declares no footprint");
    const outside = outsideFootprint(plan, parts);
    if (outside.length > 0) {
      fail(`emits outside its footprint: ${outside.slice(0, 3).join("; ")}`);
    }
    if (from && plan.entry) {
      const prev = rooms[from.room];
      const problem = jointProblem(prev.plan.exits[from.exit], plan.entry);
      if (problem) fail(`doorway from "${prev.name}": ${problem}`);
    }

    // Footprints may touch but not overlap.
    for (const other of rooms) {
      for (const a of plan.footprint) {
        for (const b of other.plan.footprint) {
          if (boxesOverlap(boxOf(a), boxOf(b), EPS)) {
            fail(
              `footprint overlap with "${other.name}": ${fmtBox(boxOf(a))} and ${fmtBox(boxOf(b))}`,
            );
          }
        }
      }
    }

    // Ids are unique across the level.
    for (const id of [
      ...parts.doors.map((d) => d.id),
      ...parts.buttons.map((b) => b.id),
      ...parts.plates.map((pl) => pl.id),
    ]) {
      if (ids.has(id)) fail(`duplicate id "${id}"`);
      ids.add(id);
    }

    rooms.push({
      name: p.name,
      module: p.module,
      at,
      plan,
      parts,
      propOffset: data.props.length,
    });
    data.brushes.push(...parts.brushes);
    data.lights.push(...parts.lights);
    data.props.push(...parts.props);
    data.doors.push(...parts.doors);
    data.buttons.push(...parts.buttons);
    data.plates.push(...parts.plates);
    data.emitters.push(...parts.emitters);
    data.zones.push(...parts.zones);
    if (role === "start") {
      start = index;
      data.playerSpawn = plan.spawn!;
    }
    if (role === "finish") {
      if (finish >= 0) fail("there is already a finish module");
      finish = index;
      data.exit = plan.exit!;
    }
  });

  if (start < 0) throw new Error("the level has no start module");
  if (finish < 0) throw new Error("the level has no finish module");
  rooms.forEach((room, i) => {
    room.plan.exits.forEach((_, e) => {
      if (!used.has(`${i}:${e}`)) {
        throw new Error(
          `exit ${e} of "${room.name}" is not attached to anything (it would be a hole)`,
        );
      }
    });
  });
  // Targets name existing doors.
  const doorIds = new Set(data.doors.map((d) => d.id));
  for (const b of [...data.buttons, ...data.plates]) {
    if (!doorIds.has(b.target)) {
      throw new Error(`"${b.id}" targets "${b.target}", which is no door`);
    }
  }

  // The solution: the rooms on the way from the start to the finish, each
  // entered by walking straight through its doorway.
  const path: number[] = [];
  for (let i = finish; ;) {
    path.unshift(i);
    if (i === start) break;
    const p = level.placements[i];
    i = p.attach?.to ?? i - 1;
  }
  const buttonIds = new Set(data.buttons.map((b) => b.id));
  for (const i of path) {
    const room = rooms[i];
    if (room.plan.entry) {
      data.solution.push({
        do: "walk",
        to: doorwayPoints(room.plan.entry.connector).after,
      });
    }
    for (const step of room.plan.solution) {
      if (
        "prop" in step &&
        (step.prop < 0 || step.prop >= room.parts.props.length)
      ) {
        throw new Error(
          `"${room.name}": its solution uses prop ${step.prop}, which it does not have`,
        );
      }
      if (step.do === "press" && !buttonIds.has(step.button)) {
        throw new Error(
          `"${room.name}": its solution presses "${step.button}", which is no button`,
        );
      }
      data.solution.push(remap(step, room.propOffset));
    }
  }
  return { data, rooms };
}
