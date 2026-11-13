/**
 * Planning a module at many candidate doorways without building it each
 * time: a module is planned once at a canonical entry (the origin, facing
 * +X) and the plan is moved rigidly to each candidate entry. Modules are
 * built through `roomFrame`, so a plan at any doorway is the canonical plan
 * rotated by quarter turns and translated (up to the 1 um snapping, which
 * the final assembly redoes exactly).
 */
import type { Vec3 } from "../../math";
import { planRoom } from "../assemble";
import { boxOf, type Box } from "../geometry";
import type {
  AnyRoomModule,
  Connector,
  DoorwayEnd,
  RoomPlan,
} from "../rooms/room";

/** A plan's footprint and doorways, moved to where it is placed. */
export interface PlacedPlan {
  footprint: Box[];
  entryEnd: DoorwayEnd | null;
  exits: { connector: Connector; end: DoorwayEnd }[];
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const PLUS_X: Vec3 = { x: 1, y: 0, z: 0 };

/** Plans made, by key; and how many were made (for the search budget). */
export class PlanCache {
  private readonly plans = new Map<string, RoomPlan>();
  /** Number of modules actually planned (cache misses). */
  built = 0;

  canonical(
    module: AnyRoomModule,
    params: unknown,
    mirror: boolean,
    size: { width: number; height: number },
    seed: number,
  ): RoomPlan {
    const key = `${module.name}|${mirror}|${size.width}|${size.height}|${seed}|${JSON.stringify(params)}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = planRoom(
        module,
        { position: ORIGIN, facing: PLUS_X, ...size },
        { params, mirror, seed },
      );
      this.plans.set(key, plan);
      this.built++;
    }
    return plan;
  }
}

/** Rigid motion taking the canonical entry to `at` (quarter turns only). */
function mover(at: Pick<Connector, "position" | "facing">) {
  const fx = at.facing.x;
  const fz = at.facing.z;
  const o = at.position;
  const point = (p: Vec3): Vec3 => ({
    x: o.x + p.x * fx - p.z * fz,
    y: o.y + p.y,
    z: o.z + p.x * fz + p.z * fx,
  });
  const dir = (d: Vec3): Vec3 => ({
    x: d.x * fx - d.z * fz + 0,
    y: d.y,
    z: d.x * fz + d.z * fx + 0,
  });
  const box = (b: Box): Box => {
    const p = point({ x: b.x0, y: b.y0, z: b.z0 });
    const q = point({ x: b.x1, y: b.y1, z: b.z1 });
    return {
      x0: Math.min(p.x, q.x),
      y0: p.y,
      z0: Math.min(p.z, q.z),
      x1: Math.max(p.x, q.x),
      y1: q.y,
      z1: Math.max(p.z, q.z),
    };
  };
  return { point, dir, box };
}

/** The canonical plan moved to the entry `at` (start modules: the root). */
export function placePlan(
  plan: RoomPlan,
  at: Pick<Connector, "position" | "facing">,
): PlacedPlan {
  const m = mover(at);
  return {
    footprint: plan.footprint.map((b) => m.box(boxOf(b))),
    entryEnd: plan.entry ? plan.entry.end : null,
    exits: plan.exits.map((e) => ({
      connector: {
        ...e.connector,
        position: m.point(e.connector.position),
        facing: m.dir(e.connector.facing),
      },
      end: e.end,
    })),
  };
}
