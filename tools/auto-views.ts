/**
 * Automatic viewpoints for ANY level, derived from `LevelData` alone (pure:
 * no browser), for the tour and the visual lint when a level is chosen with
 * `--seed` or `--rooms` (or `--auto`).
 *
 * Per acoustic zone (room), at eye height on open floor (candidate points on
 * a 0.5 m grid with clearance from brushes, props and closed doors):
 *   zNN-corner-ne|nw|se|sw   near each corner, looking toward the centre
 *   zNN-center-e|w|n|s       at the centre, looking at each wall (a wall
 *                            closer than 1 m along the view is skipped)
 *   zNN-ceiling, zNN-floor   at the centre looking up and down
 * Per door: `door-<id>-a` and `-b` (from each side, looking at it, closed)
 * and `door-<id>-through` (from side a looking through, doors open).
 * Per button, plate and the exit box: `button-<id>`, `plate-<id>`, `exit`,
 * a close view from the nearest sensible standing point with a clear line of
 * sight. Names are deterministic (zone and door order of the level data).
 * At most `maxPerRoom` (12) views per zone.
 */
import type { LevelData } from "../src/core/api";
import { PLAYER } from "../src/core/props";
import { boxOf, boxesOverlap, propBox, type Box } from "../src/level/geometry";
import { lookToward, type Point3 } from "./pilot-math";
import type { Viewpoint } from "./views";

export interface AutoViewOptions {
  maxPerRoom?: number;
  /** Grid step for candidate standing points. Default 0.5 m. */
  grid?: number;
}

interface World {
  /** Brushes that stop a player standing at some floor (checked per floor). */
  brushes: Box[];
  /** Things a player cannot stand in besides brushes: props, closed doors. */
  extras: Box[];
  /** Brushes plus closed doors: what blocks sight. */
  blockers: Box[];
}

/** Distance along a ray to the first box it enters (Infinity if none within maxT). */
export function rayDistance(
  o: Point3,
  d: Point3,
  boxes: readonly Box[],
  maxT = 60,
): number {
  let best = Infinity;
  for (const b of boxes) {
    let tmin = 0;
    let tmax = Math.min(maxT, best);
    let ok = true;
    const axes: [number, number, number, number][] = [
      [o.x, d.x, b.x0, b.x1],
      [o.y, d.y, b.y0, b.y1],
      [o.z, d.z, b.z0, b.z1],
    ];
    let inside = true;
    for (const [oo, dd, lo, hi] of axes) {
      if (Math.abs(dd) < 1e-12) {
        if (oo < lo || oo > hi) {
          ok = false;
          break;
        }
        continue;
      }
      let t0 = (lo - oo) / dd;
      let t1 = (hi - oo) / dd;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > 0) inside = false;
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
      if (tmin > tmax) {
        ok = false;
        break;
      }
    }
    // A ray starting inside a box does not count it (embedded in geometry).
    if (ok && !inside && tmin < best) best = tmin;
  }
  return best;
}

function worldOf(level: LevelData): World {
  const brushes = level.brushes.map(boxOf);
  const extras = [
    ...level.props.map(propBox),
    ...level.doors.map((d) => boxOf(d.closed)),
  ];
  return {
    brushes,
    extras,
    blockers: [...brushes, ...level.doors.map((d) => boxOf(d.closed))],
  };
}

const R = 0.4;

/** Is there floor at `floorY` under (x, z), and room to stand (and look) there? */
function standable(w: World, x: number, z: number, floorY: number): boolean {
  const body: Box = {
    x0: x - R,
    x1: x + R,
    z0: z - R,
    z1: z + R,
    y0: floorY + 0.1,
    y1: floorY + PLAYER.standHeight + 0.1,
  };
  let floor = false;
  for (const b of w.brushes) {
    if (
      Math.abs(b.y1 - floorY) < 0.06 &&
      x >= b.x0 &&
      x <= b.x1 &&
      z >= b.z0 &&
      z <= b.z1
    ) {
      floor = true;
    }
    if (b.y1 > floorY + 0.06 && boxesOverlap(b, body)) return false;
  }
  if (!floor) return false;
  return !w.extras.some((b) => boxesOverlap(b, body));
}

/**
 * The floor height of a zone: zone boxes may reach below the floor, so take
 * the brush top (within a metre and a half of the box's bottom) with the
 * most standing room on it.
 */
function zoneFloor(w: World, zone: Box, grid: number): number {
  const tops = new Set<number>();
  for (const b of w.brushes) {
    if (
      b.x1 > zone.x0 &&
      b.x0 < zone.x1 &&
      b.z1 > zone.z0 &&
      b.z0 < zone.z1 &&
      b.y1 >= zone.y0 - 0.3 &&
      b.y1 <= zone.y0 + 1.5
    ) {
      tops.add(Math.round(b.y1 * 100) / 100);
    }
  }
  let best = zone.y0;
  let bestCount = -1;
  for (const top of [...tops].sort((p, q) => p - q)) {
    let count = 0;
    for (let x = zone.x0 + 0.5; x <= zone.x1 - 0.5 + 1e-9; x += grid) {
      for (let z = zone.z0 + 0.5; z <= zone.z1 - 0.5 + 1e-9; z += grid) {
        if (standable(w, x, z, top)) count++;
      }
    }
    if (count > bestCount) {
      best = top;
      bestCount = count;
    }
  }
  return best;
}

const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;

function viewAt(
  name: string,
  x: number,
  floorY: number,
  z: number,
  target: Point3,
  doors: "closed" | "open" = "closed",
): Viewpoint {
  const eye = { x, y: floorY + PLAYER.eyeHeight, z };
  const look = lookToward(eye, target);
  return {
    name,
    pos: [round(eye.x), round(eye.y), round(eye.z)],
    yaw: round(look.yawDeg),
    pitch: round(look.pitchDeg),
    doors,
  };
}

/** Candidate points around `target` (nearest first) with a clear sight line to it. */
function nearView(
  w: World,
  target: Point3,
  floorY: number,
  distances: readonly number[],
  preferred: Point3 | null,
): { x: number; z: number } | null {
  const eyeY = floorY + PLAYER.eyeHeight;
  // Angles: around the preferred direction first (the way a button faces),
  // then the whole circle.
  const base = preferred ? Math.atan2(preferred.z, preferred.x) : 0;
  const offsets = [
    0,
    0.35,
    -0.35,
    0.7,
    -0.7,
    1.05,
    -1.05,
    1.57,
    -1.57,
    2.1,
    -2.1,
    2.6,
    -2.6,
    Math.PI,
  ];
  for (const dist of distances) {
    for (const off of offsets) {
      const a = base + off;
      const x = target.x + Math.cos(a) * dist;
      const z = target.z + Math.sin(a) * dist;
      if (!standable(w, x, z, floorY)) continue;
      const eye = { x, y: eyeY, z };
      const dx = target.x - eye.x;
      const dy = target.y - eye.y;
      const dz = target.z - eye.z;
      const len = Math.hypot(dx, dy, dz);
      const hit = rayDistance(
        eye,
        { x: dx / len, y: dy / len, z: dz / len },
        w.blockers,
        len,
      );
      // Clear if nothing is hit before the last 12 cm (the target's own wall or slab).
      if (hit >= len - 0.12) return { x, z };
    }
  }
  return null;
}

/** All automatic viewpoints of a level. */
export function autoViews(
  level: LevelData,
  options: AutoViewOptions = {},
): Viewpoint[] {
  const w = worldOf(level);
  const cap = options.maxPerRoom ?? 12;
  const grid = options.grid ?? 0.5;
  const views: Viewpoint[] = [];
  const zoneBoxes = level.zones.map((z) => boxOf(z.box));
  const floors = zoneBoxes.map((b) => zoneFloor(w, b, grid));
  /** Floor height under a point: its zone's, else 0. */
  const floorAt = (x: number, z: number, y: number): number => {
    const i = zoneBoxes.findIndex(
      (b) =>
        x >= b.x0 &&
        x <= b.x1 &&
        z >= b.z0 &&
        z <= b.z1 &&
        y >= b.y0 - 0.1 &&
        y <= b.y1 + 0.1,
    );
    return i >= 0 ? floors[i] : 0;
  };

  // --- Rooms ---------------------------------------------------------------
  level.zones.forEach((zone, zi) => {
    const b = boxOf(zone.box);
    const floorY = floors[zi];
    const tag = `z${String(zi).padStart(2, "0")}`;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const points: { x: number; z: number }[] = [];
    for (let x = b.x0 + 0.5; x <= b.x1 - 0.5 + 1e-9; x += grid) {
      for (let z = b.z0 + 0.5; z <= b.z1 - 0.5 + 1e-9; z += grid) {
        if (standable(w, x, z, floorY))
          points.push({ x: round(x), z: round(z) });
      }
    }
    if (points.length === 0) return;
    const nearest = (tx: number, tz: number): { x: number; z: number } =>
      points.reduce((best, p) =>
        Math.hypot(p.x - tx, p.z - tz) < Math.hypot(best.x - tx, best.z - tz)
          ? p
          : best,
      );
    const eyeY = floorY + PLAYER.eyeHeight;
    const room: Viewpoint[] = [];
    const centre = nearest(cx, cz);
    const farEnough = (
      p: { x: number; z: number },
      t: Point3,
      min: number,
    ): boolean => {
      const eye = { x: p.x, y: eyeY, z: p.z };
      const dx = t.x - eye.x;
      const dy = t.y - eye.y;
      const dz = t.z - eye.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      return (
        rayDistance(
          eye,
          { x: dx / len, y: dy / len, z: dz / len },
          w.blockers,
        ) >= min
      );
    };
    // Corners looking toward the centre.
    const corners: [string, number, number][] = [
      ["ne", b.x1, b.z0],
      ["nw", b.x0, b.z0],
      ["se", b.x1, b.z1],
      ["sw", b.x0, b.z1],
    ];
    for (const [name, kx, kz] of corners) {
      const p = nearest(
        kx + (kx > cx ? -0.6 : 0.6),
        kz + (kz > cz ? -0.6 : 0.6),
      );
      const target = { x: cx, y: eyeY, z: cz };
      if (Math.hypot(p.x - cx, p.z - cz) < 1.2) continue;
      if (!farEnough(p, target, 1.0)) continue;
      room.push(viewAt(`${tag}-corner-${name}`, p.x, floorY, p.z, target));
    }
    // The centre looking at each wall.
    const walls: [string, Point3][] = [
      ["e", { x: b.x1, y: eyeY, z: centre.z }],
      ["w", { x: b.x0, y: eyeY, z: centre.z }],
      ["n", { x: centre.x, y: eyeY, z: b.z0 }],
      ["s", { x: centre.x, y: eyeY, z: b.z1 }],
    ];
    for (const [name, target] of walls) {
      if (!farEnough(centre, target, 1.0)) continue;
      room.push(
        viewAt(`${tag}-center-${name}`, centre.x, floorY, centre.z, target),
      );
    }
    // Ceiling and floor from the centre.
    const up = viewAt(`${tag}-ceiling`, centre.x, floorY, centre.z, {
      x: centre.x + 0.01,
      y: eyeY + 2,
      z: centre.z,
    });
    up.pitch = 60;
    room.push(up);
    const down = viewAt(`${tag}-floor`, centre.x, floorY, centre.z, {
      x: centre.x + 0.01,
      y: eyeY - 2,
      z: centre.z,
    });
    down.pitch = -55;
    down.yaw = round(room[0]?.yaw ?? 0);
    room.push(down);
    views.push(...room.slice(0, cap));
  });

  // --- Doors ---------------------------------------------------------------
  for (const door of level.doors) {
    const c = boxOf(door.closed);
    const thinX = c.x1 - c.x0 <= c.z1 - c.z0;
    const normal = thinX ? { x: 1, z: 0 } : { x: 0, z: 1 };
    const mid = {
      x: (c.x0 + c.x1) / 2,
      y: Math.min(c.y1, c.y0 + 1.3),
      z: (c.z0 + c.z1) / 2,
    };
    const floorY = floorAt(mid.x, mid.z, c.y0 + 0.2);
    const sides: ["a" | "b", number][] = [
      ["a", 1],
      ["b", -1],
    ];
    const found: Partial<
      Record<"a" | "b", { x: number; z: number; d: number }>
    > = {};
    for (const [side, sign] of sides) {
      let done = false;
      for (const d of [2.0, 1.6, 2.5, 1.2, 3.0, 3.5]) {
        for (const lateral of [0, 0.35, -0.35, 0.7, -0.7]) {
          const x = mid.x + normal.x * sign * d + (thinX ? 0 : lateral);
          const z = mid.z + normal.z * sign * d + (thinX ? lateral : 0);
          if (!standable(w, x, z, floorY)) continue;
          found[side] = { x, z, d };
          done = true;
          break;
        }
        if (done) break;
      }
    }
    for (const [side] of sides) {
      const p = found[side];
      if (p)
        views.push(viewAt(`door-${door.id}-${side}`, p.x, floorY, p.z, mid));
    }
    // Through it, open: from side a at the far end of a straight line.
    const a = found.a;
    if (a) {
      views.push(
        viewAt(
          `door-${door.id}-through`,
          a.x,
          floorY,
          a.z,
          {
            x: mid.x - normal.x * 6,
            y: floorY + PLAYER.eyeHeight,
            z: mid.z - normal.z * 6,
          },
          "open",
        ),
      );
    }
  }

  // --- Buttons, plates, exit --------------------------------------------------
  for (const button of level.buttons) {
    const p = button.position;
    const floorY = floorAt(p.x, p.z, p.y);
    const f = { x: button.facing.x, y: 0, z: button.facing.z };
    const at = nearView(w, p, floorY, [1.3, 1.7, 2.3, 3.2, 4.2], f);
    if (at) views.push(viewAt(`button-${button.id}`, at.x, floorY, at.z, p));
  }
  for (const plate of level.plates) {
    const b = boxOf(plate.box);
    const centre = { x: (b.x0 + b.x1) / 2, y: b.y0, z: (b.z0 + b.z1) / 2 };
    const floorY = floorAt(centre.x, centre.z, b.y0 + 0.2);
    const at = nearView(w, centre, floorY, [2.0, 2.6, 3.4, 1.6], null);
    if (at) views.push(viewAt(`plate-${plate.id}`, at.x, floorY, at.z, centre));
  }
  {
    const b = boxOf(level.exit);
    const centre = { x: (b.x0 + b.x1) / 2, y: b.y0 + 1, z: (b.z0 + b.z1) / 2 };
    const floorY = floorAt(centre.x, centre.z, b.y0 + 0.2);
    let at = nearView(w, centre, floorY, [2.5, 3.2, 4.0, 1.8], null);
    if (!at) {
      // A small exit room: stand in it, as far from the middle as it allows.
      let far = -1;
      for (let x = b.x0 + 0.4; x <= b.x1 - 0.4 + 1e-9; x += 0.5) {
        for (let z = b.z0 + 0.4; z <= b.z1 - 0.4 + 1e-9; z += 0.5) {
          const d = Math.hypot(x - centre.x, z - centre.z);
          if (d > far && standable(w, x, z, floorY)) {
            far = d;
            at = { x: round(x), z: round(z) };
          }
        }
      }
    }
    if (at) views.push(viewAt("exit", at.x, floorY, at.z, centre));
  }
  return views;
}

export interface FloorPoint {
  x: number;
  z: number;
  floorY: number;
  /** Index into `level.zones`. */
  zone: number;
}

/**
 * Open floor in every zone on a grid of `step` metres (standable: floor under
 * it, clearance from brushes, props and closed doors). The first zone to
 * contain a point owns it.
 */
export function floorPoints(level: LevelData, step: number): FloorPoint[] {
  const w = worldOf(level);
  const out: FloorPoint[] = [];
  const seen = new Set<string>();
  level.zones.forEach((zone, zi) => {
    const b = boxOf(zone.box);
    const floorY = zoneFloor(w, b, 0.5);
    for (let x = b.x0 + 0.4; x <= b.x1 - 0.4 + 1e-9; x += step) {
      for (let z = b.z0 + 0.4; z <= b.z1 - 0.4 + 1e-9; z += step) {
        const key = `${round(x)},${round(z)},${floorY}`;
        if (seen.has(key) || !standable(w, x, z, floorY)) continue;
        seen.add(key);
        out.push({ x: round(x), z: round(z), floorY, zone: zi });
      }
    }
  });
  return out;
}
