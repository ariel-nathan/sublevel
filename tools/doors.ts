/**
 * Opens every door of ANY level in a running game without playing it, for
 * the tour, the visual lint and the coverage sweep ("doors open" state).
 *
 * There is no hook in the game to force a door, so each door is opened the
 * way its controls are operated, from the page:
 *   toggle buttons  `__game.world.use` with a synthetic ray at the button
 *   plates          heavy props are teleported onto the plate (the load
 *                   logic counts bodies over the footprint) and let fall
 *   impact buttons  a prop is teleported in front of the button and given
 *                   speed into it, as a throw would
 *   timed buttons   pressed last, all together, then stepped until every
 *                   door they control is open (their countdown has not run
 *                   out: nothing steps once this returns)
 * and checked: a door is open when its slab no longer fills the middle of
 * its closed box. Props used are moved (that is part of the state).
 *
 * What a hook would replace: a `WorldObjects.forceDoors(open: boolean)` that
 * latches every door, see the tools README.
 */
import type { Aabb, LevelData } from "../src/core/api";
import type { GameSession } from "./browser";

export interface BodyLite {
  id: number;
  tag: string;
  mass: number;
  halfExtents: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
}

export interface Pose {
  id: number;
  position: { x: number; y: number; z: number };
}

/**
 * Where to put props so that they weigh down a plate of `required` kg: the
 * lightest sufficient single body, else the heaviest ones stacked in the
 * middle of the footprint (each resting on the one below, 5 mm apart so they
 * settle instead of interpenetrating). Null if all the bodies together are
 * too light.
 */
export function plateStack(
  plate: Aabb,
  required: number,
  bodies: readonly BodyLite[],
  skip: ReadonlySet<number> = new Set(),
): Pose[] | null {
  const free = bodies.filter((b) => !skip.has(b.id) && b.mass > 0);
  const cx = (plate.min.x + plate.max.x) / 2;
  const cz = (plate.min.z + plate.max.z) / 2;
  const floor = plate.min.y;
  const single = free
    .filter((b) => b.mass >= required)
    .sort((a, b) => a.mass - b.mass)[0];
  const chosen: BodyLite[] = [];
  if (single) {
    chosen.push(single);
  } else {
    let sum = 0;
    for (const b of [...free].sort((a, c) => c.mass - a.mass)) {
      chosen.push(b);
      sum += b.mass;
      if (sum >= required) break;
    }
    if (sum < required) return null;
  }
  const poses: Pose[] = [];
  let y = floor + 0.005;
  for (const b of chosen) {
    poses.push({
      id: b.id,
      position: { x: cx, y: y + b.halfExtents.y, z: cz },
    });
    y += 2 * b.halfExtents.y + 0.005;
  }
  return poses;
}

/** Page expression: is this door's slab out of the middle of its closed box? */
function isOpenExpr(closed: Aabb): string {
  const c = {
    x: (closed.min.x + closed.max.x) / 2,
    y: (closed.min.y + closed.max.y) / 2,
    z: (closed.min.z + closed.max.z) / 2,
  };
  const h = {
    x: ((closed.max.x - closed.min.x) / 2) * 0.4,
    y: ((closed.max.y - closed.min.y) / 2) * 0.4,
    z: ((closed.max.z - closed.min.z) / 2) * 0.4,
  };
  const probe = JSON.stringify({
    min: { x: c.x - h.x, y: c.y - h.y, z: c.z - h.z },
    max: { x: c.x + h.x, y: c.y + h.y, z: c.z + h.z },
  });
  return `!__game.physics.overlapBox(${probe}).some((c) => c.kind === "kinematic")`;
}

export interface OpenReport {
  /** Door ids that are open now. */
  open: string[];
  /** Door ids that could not be opened, with why. */
  failed: { door: string; why: string }[];
  /** What was done, for the log. */
  log: string[];
}

/** Opens every door; see the file header. Does not throw. */
export async function openAllDoors(
  session: GameSession,
  level?: LevelData,
): Promise<OpenReport> {
  const data =
    level ?? (await session.evaluate<LevelData>("__game.level.data"));
  const log: string[] = [];
  const isOpen = (id: string): Promise<boolean> =>
    session.evaluate<boolean>(
      isOpenExpr(data.doors.find((d) => d.id === id)!.closed),
    );
  const step = (n: number): Promise<void> =>
    session.evaluate(`__harness.step(${n})`);
  const press = (b: LevelData["buttons"][number]): Promise<void> =>
    session.evaluate(
      `__game.world.use({ collider: { kind: "static", id: 0 }, point: ${JSON.stringify(b.position)}, normal: ${JSON.stringify(b.facing)}, distance: 1 })`,
    );
  const bodies = (): Promise<BodyLite[]> =>
    session.evaluate<BodyLite[]>(
      `__game.physics.bodies().filter((b) => b.tag && b.mass > 0 && b.mass < 1e6).map((b) => ({ id: b.id, tag: b.tag, mass: b.mass, halfExtents: b.halfExtents, position: b.position }))`,
    );
  const used = new Set<number>();

  // Toggle buttons (a door may have two; pressing both would close it again).
  const toggled = new Set<string>();
  for (const b of data.buttons) {
    if ((b.mode ?? "toggle") !== "toggle") continue;
    if (!data.doors.some((d) => d.id === b.target)) continue;
    if (toggled.has(b.target) || (await isOpen(b.target))) continue;
    toggled.add(b.target);
    await press(b);
    log.push(`pressed ${b.id}`);
  }
  await step(90);

  // Plates.
  for (const plate of data.plates) {
    if (await isOpen(plate.target)) continue;
    const poses = plateStack(
      plate.box,
      plate.requiredMass,
      await bodies(),
      used,
    );
    if (!poses) {
      log.push(
        `no props heavy enough for ${plate.id} (${plate.requiredMass} kg)`,
      );
      continue;
    }
    for (const p of poses) {
      used.add(p.id);
      await session.evaluate(
        `__game.physics.setBodyPose(${p.id}, ${JSON.stringify(p.position)}); __game.physics.setBodyVelocity(${p.id}, { x: 0, y: 0, z: 0 })`,
      );
    }
    log.push(`put ${poses.length} prop(s) on ${plate.id}`);
    await step(120);
  }

  // Impact buttons: a prop thrown into them at 8 m/s.
  for (const b of data.buttons) {
    if (b.mode !== "impact") continue;
    if (await isOpen(b.target)) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidates = (await bodies())
        .filter((x) => !used.has(x.id) && x.mass >= 1)
        .sort((p, q) => p.mass - q.mass);
      const prop = candidates[0];
      if (!prop) {
        log.push(`no prop left to hit ${b.id}`);
        break;
      }
      used.add(prop.id);
      const f = b.facing;
      const out = prop.halfExtents.x + 0.35;
      await session.evaluate(
        `__game.physics.setBodyPose(${prop.id}, { x: ${b.position.x + f.x * out}, y: ${b.position.y}, z: ${b.position.z + f.z * out} });` +
          `__game.physics.setBodyVelocity(${prop.id}, { x: ${-f.x * 8}, y: ${-f.y * 8}, z: ${-f.z * 8} })`,
      );
      await step(40);
      log.push(`threw ${prop.tag}#${prop.id} at ${b.id}`);
      if (await isOpen(b.target)) break;
    }
  }
  await step(60);

  // Timed buttons last, all at once.
  const timed = data.buttons.filter((b) => b.mode === "timed");
  for (const b of timed) {
    if (await isOpen(b.target)) continue;
    await press(b);
    log.push(`pressed ${b.id} (timed)`);
  }
  if (timed.length > 0) {
    for (let i = 0; i < 40; i++) {
      let all = true;
      for (const b of timed) all = all && (await isOpen(b.target));
      if (all) break;
      await step(5);
    }
  }

  const open: string[] = [];
  const failed: { door: string; why: string }[] = [];
  for (const d of data.doors) {
    if (await isOpen(d.id)) open.push(d.id);
    else
      failed.push({
        door: d.id,
        why: "still shut after every control was used",
      });
  }
  return { open, failed, log };
}
